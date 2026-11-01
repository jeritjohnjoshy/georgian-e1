import io
import gc
import logging
import os
from contextlib import asynccontextmanager
from threading import Lock
from time import perf_counter

import av
import numpy as np
import torch
from fastapi.concurrency import run_in_threadpool
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from transformers import WhisperForConditionalGeneration, WhisperProcessor

logger = logging.getLogger("georgian_asr")
ASR_MODELS = {
    "openai/whisper-large-v3-turbo": "Whisper large-v3 Turbo (testing default)",
    "BuzzASR/georgian": "BuzzASR Georgian (accuracy comparison)",
}
AZURE_MODEL_ID = "azure/speech-ka-GE"
AZURE_SPEECH_KEY = os.getenv("AZURE_SPEECH_KEY", "").strip()
AZURE_SPEECH_REGION = os.getenv("AZURE_SPEECH_REGION", "").strip()
AZURE_CONFIGURED = bool(AZURE_SPEECH_KEY and AZURE_SPEECH_REGION)
if AZURE_CONFIGURED:
    ASR_MODELS[AZURE_MODEL_ID] = "Azure Speech Georgian (cloud, F0 eligible)"
MODEL_ID = os.getenv("ASR_MODEL_ID", "openai/whisper-large-v3-turbo")
if MODEL_ID not in ASR_MODELS:
    logger.warning("Unknown ASR_MODEL_ID %s; falling back to Whisper large-v3-turbo", MODEL_ID)
    MODEL_ID = "openai/whisper-large-v3-turbo"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.float16 if DEVICE == "cuda" else torch.float32
CPU_THREADS = max(1, int(os.getenv("ASR_CPU_THREADS", str(os.cpu_count() or 1))))
USE_CPU_INT8 = DEVICE == "cpu" and os.getenv("ASR_CPU_INT8", "1").lower() not in {"0", "false", "no"}
INFERENCE_MODE = "cuda-fp16" if DEVICE == "cuda" else "cpu-fp32"
OCR_MAX_BYTES = 12 * 1024 * 1024
OCR_MAX_TEXT_CHARS = 6000
if DEVICE == "cpu":
    torch.set_num_threads(CPU_THREADS)
model = None
processor = None
inference_lock = Lock()
ocr_engines = {}
ocr_init_lock = Lock()


class ModelSelection(BaseModel):
    model_id: str


def load_asr_model(model_id: str):
    logger.info("Loading ASR model %s on %s", model_id, DEVICE)
    loaded_processor = WhisperProcessor.from_pretrained(model_id)
    loaded_model = WhisperForConditionalGeneration.from_pretrained(
        model_id,
        torch_dtype=DTYPE,
        low_cpu_mem_usage=True,
        use_safetensors=True,
    ).to(DEVICE).eval()
    inference_mode = "cuda-fp16" if DEVICE == "cuda" else "cpu-fp32"
    if USE_CPU_INT8:
        try:
            loaded_model = torch.ao.quantization.quantize_dynamic(
                loaded_model,
                {torch.nn.Linear},
                dtype=torch.qint8,
            ).eval()
            inference_mode = "cpu-dynamic-int8"
            logger.info("Enabled dynamic int8 quantization for CPU linear layers")
        except Exception:
            logger.exception("CPU int8 quantization unavailable; using float32 inference")
    return loaded_model, loaded_processor, inference_mode


def load_audio(audio_bytes: bytes) -> np.ndarray:
    try:
        container = av.open(io.BytesIO(audio_bytes))
        audio_stream = next(stream for stream in container.streams if stream.type == "audio")
        resampler = av.AudioResampler(format="fltp", layout="mono", rate=16_000)
        frames = []

        for frame in container.decode(audio_stream):
            converted = resampler.resample(frame)
            if converted:
                frames.extend(converted)

        converted = resampler.resample(None)
        if converted:
            frames.extend(converted)
        container.close()
    except Exception as exc:
        logger.warning("Audio decoding failed: %s", exc)
        raise HTTPException(status_code=400, detail="Could not decode the uploaded audio.") from exc

    if not frames:
        raise HTTPException(status_code=400, detail="The uploaded audio contains no samples.")

    return np.concatenate([frame.to_ndarray().reshape(-1) for frame in frames]).astype(np.float32)


def transcribe(audio: np.ndarray) -> str:
    segments = []
    chunk_samples = 28 * 16_000
    chunk_count = (len(audio) + chunk_samples - 1) // chunk_samples
    forced_decoder_ids = getattr(model.generation_config, "forced_decoder_ids", None) or []
    decoder_prefix_length = 1 + len(forced_decoder_ids)
    max_new_tokens = max(1, model.config.max_target_positions - decoder_prefix_length - 1)
    started_at = perf_counter()
    logger.info("Transcription started: %.1f seconds, %d chunks", len(audio) / 16_000, chunk_count)

    try:
        with inference_lock, torch.inference_mode():
            for offset in range(0, len(audio), chunk_samples):
                chunk = audio[offset : offset + chunk_samples]
                inputs = processor(chunk, sampling_rate=16_000, return_tensors="pt")
                features = inputs.input_features.to(device=DEVICE, dtype=DTYPE)
                token_ids = model.generate(
                    features,
                    num_beams=1,
                    no_repeat_ngram_size=3,
                    repetition_penalty=1.2,
                    max_new_tokens=max_new_tokens,
                )
                text = processor.batch_decode(token_ids, skip_special_tokens=True)[0].strip()
                if text:
                    segments.append(text)
    except Exception as exc:
        logger.exception("Transcription failed")
        raise HTTPException(status_code=500, detail="Transcription failed. Check the server log.") from exc

    result = " ".join(segments)
    logger.info("Transcription completed in %.2f seconds (%d characters)", perf_counter() - started_at, len(result))
    return result


def transcribe_with_azure(audio: np.ndarray) -> str:
    if not AZURE_CONFIGURED:
        raise HTTPException(status_code=503, detail="Configure AZURE_SPEECH_KEY and AZURE_SPEECH_REGION to use Azure Speech.")
    try:
        import azure.cognitiveservices.speech as speechsdk
    except ImportError as exc:
        logger.exception("Azure Speech SDK is not installed")
        raise HTTPException(status_code=503, detail="Azure Speech support is not installed. Run uv sync in the server directory.") from exc

    speech_config = speechsdk.SpeechConfig(subscription=AZURE_SPEECH_KEY, region=AZURE_SPEECH_REGION)
    speech_config.speech_recognition_language = "ka-GE"
    audio_format = speechsdk.audio.AudioStreamFormat(
        samples_per_second=16_000,
        bits_per_sample=16,
        channels=1,
    )
    push_stream = speechsdk.audio.PushAudioInputStream(stream_format=audio_format)
    audio_config = speechsdk.audio.AudioConfig(stream=push_stream)
    recognizer = speechsdk.SpeechRecognizer(speech_config=speech_config, audio_config=audio_config)
    recognized_segments = []
    cancellation_errors = []
    finished = __import__("threading").Event()

    def on_recognized(event):
        if event.result.reason == speechsdk.ResultReason.RecognizedSpeech and event.result.text.strip():
            recognized_segments.append(event.result.text.strip())

    def on_canceled(event):
        if event.reason == speechsdk.CancellationReason.Error:
            cancellation_errors.append(event.error_details or "Azure Speech canceled recognition.")
        finished.set()

    recognizer.recognized.connect(on_recognized)
    recognizer.canceled.connect(on_canceled)
    recognizer.session_stopped.connect(lambda _: finished.set())
    started = False
    started_at = perf_counter()
    try:
        recognizer.start_continuous_recognition_async().get()
        started = True
        pcm_audio = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16).tobytes()
        push_stream.write(pcm_audio)
        push_stream.close()
        timeout = max(45, len(audio) / 16_000 * 3 + 30)
        if not finished.wait(timeout):
            raise HTTPException(status_code=504, detail="Azure Speech timed out while transcribing the recording.")
        if cancellation_errors:
            logger.error("Azure Speech recognition canceled: %s", cancellation_errors[0])
            raise HTTPException(status_code=502, detail="Azure Speech could not transcribe this recording. Check the key, region, and F0 quota.")
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Azure Speech transcription failed")
        raise HTTPException(status_code=502, detail="Azure Speech transcription failed. Check the key, region, network, and F0 quota.") from exc
    finally:
        if started:
            try:
                recognizer.stop_continuous_recognition_async().get()
            except Exception:
                logger.debug("Azure Speech recognizer stop returned an error", exc_info=True)
        recognizer.close()
        audio_config.close()
        push_stream.close()

    result = " ".join(recognized_segments)
    logger.info("Azure Speech transcription completed in %.2f seconds (%d characters)", perf_counter() - started_at, len(result))
    return result


def get_ocr_engine(language: str):
    if language not in {"en", "ka"}:
        raise ValueError(f"Unsupported OCR language: {language}")
    if language not in ocr_engines:
        with ocr_init_lock:
            if language not in ocr_engines:
                from rapidocr import RapidOCR

                if language == "en":
                    logger.info("Initializing RapidOCR English-capable PP-OCRv6 engine")
                    ocr_engines[language] = RapidOCR()
                else:
                    from rapidocr import EngineType, ModelType, OCRVersion

                    logger.info("Initializing RapidOCR Georgian PP-OCRv4 recognizer")
                    ocr_engines[language] = RapidOCR(params={
                        "Rec.engine_type": EngineType.ONNXRUNTIME,
                        "Rec.lang_type": "ka",
                        "Rec.model_type": ModelType.MOBILE,
                        "Rec.ocr_version": OCRVersion.PPOCRV4,
                    })
    return ocr_engines[language]


def extract_screen_text(image_bytes: bytes) -> str:
    recognized_lines = []
    for language in ("en", "ka"):
        try:
            result = get_ocr_engine(language)(image_bytes)
        except Exception as exc:
            logger.exception("Screen OCR failed for %s", language)
            if language == "en":
                raise HTTPException(status_code=500, detail="English screen OCR failed. Check the server log.") from exc
            continue

        boxes = getattr(result, "boxes", None)
        if boxes is None:
            boxes = []
        texts = getattr(result, "txts", None) or []
        scores = getattr(result, "scores", None) or []
        for index, (box, text) in enumerate(zip(boxes, texts)):
            text = text.strip() if text else ""
            if not text:
                continue
            score = scores[index] if index < len(scores) else 1.0
            if score < (0.25 if language == "ka" else 0.30):
                continue
            has_georgian = any("\u10a0" <= char <= "\u10ff" or "\u1c90" <= char <= "\u1cbf" for char in text)
            has_latin_or_digit = any(char.isascii() and (char.isalpha() or char.isdigit()) for char in text)
            if language == "ka" and not has_georgian:
                continue
            if language == "en" and not has_latin_or_digit:
                continue
            coordinates = np.asarray(box)
            recognized_lines.append((float(coordinates[:, 1].min()), float(coordinates[:, 0].min()), text))

    recognized_lines.sort(key=lambda line: (line[0], line[1]))
    lines = [line[2] for line in recognized_lines]
    extracted = "\n".join(lines)
    if not extracted:
        raise HTTPException(status_code=422, detail="No readable English or Georgian text was found in that screen area.")
    if len(extracted) > OCR_MAX_TEXT_CHARS:
        raise HTTPException(status_code=413, detail="The selected area contains too much text. Select a smaller area.")
    logger.info("Bilingual OCR extracted %d lines (%d characters)", len(lines), len(extracted))
    return extracted


@asynccontextmanager
async def lifespan(_: FastAPI):
    global model, processor, INFERENCE_MODE
    started_at = perf_counter()
    if DEVICE == "cpu":
        logger.info("CPU inference threads: %d; dynamic int8 requested: %s", CPU_THREADS, USE_CPU_INT8)
    if MODEL_ID == AZURE_MODEL_ID:
        INFERENCE_MODE = "azure-speech"
        logger.info("Azure Speech is selected; local model weights will not be loaded")
    else:
        try:
            model, processor, INFERENCE_MODE = load_asr_model(MODEL_ID)
        except Exception:
            logger.exception("Failed to load ASR model %s", MODEL_ID)
            raise
        logger.info("ASR model ready in %.2f seconds", perf_counter() - started_at)
    yield
    logger.info("Unloading ASR model")
    model = None
    processor = None


def select_asr_model(model_id: str):
    global model, processor, MODEL_ID, INFERENCE_MODE
    if model_id not in ASR_MODELS:
        raise HTTPException(status_code=400, detail="Choose one of the models listed by GET /models.")
    if model_id == AZURE_MODEL_ID:
        with inference_lock:
            model = None
            processor = None
            gc.collect()
            if DEVICE == "cuda":
                torch.cuda.empty_cache()
            MODEL_ID = AZURE_MODEL_ID
            INFERENCE_MODE = "azure-speech"
        logger.info("ASR model switched to Azure Speech Georgian")
        return
    if model_id == MODEL_ID and model is not None:
        return

    with inference_lock:
        previous_model_id = MODEL_ID
        model = None
        processor = None
        gc.collect()
        if DEVICE == "cuda":
            torch.cuda.empty_cache()
        try:
            model, processor, INFERENCE_MODE = load_asr_model(model_id)
            MODEL_ID = model_id
        except Exception as exc:
            logger.exception("Could not load requested ASR model %s", model_id)
            if previous_model_id == AZURE_MODEL_ID and AZURE_CONFIGURED:
                MODEL_ID = AZURE_MODEL_ID
                INFERENCE_MODE = "azure-speech"
            else:
                try:
                    model, processor, INFERENCE_MODE = load_asr_model(previous_model_id)
                except Exception:
                    logger.exception("Could not restore previous ASR model %s", previous_model_id)
            raise HTTPException(status_code=500, detail="Could not load the selected ASR model. Check the server log.") from exc

    logger.info("ASR model switched to %s", MODEL_ID)


app = FastAPI(title="Georgian Audio Transcription", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"(chrome-extension://[a-p]{32}|http://(localhost|127\.0\.0\.1)(:\d+)?)",
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    model_ready = model is not None or (MODEL_ID == AZURE_MODEL_ID and AZURE_CONFIGURED)
    return {
        "status": "ready" if model_ready else "loading",
        "model": MODEL_ID,
        "device": DEVICE,
        "inference_mode": INFERENCE_MODE,
        "cpu_threads": CPU_THREADS if DEVICE == "cpu" else None,
        "ocr_loaded": bool(ocr_engines),
        "azure_speech_configured": AZURE_CONFIGURED,
    }


@app.get("/models")
def list_asr_models():
    model_ready = model is not None or (MODEL_ID == AZURE_MODEL_ID and AZURE_CONFIGURED)
    return {
        "models": [{"id": model_id, "label": label} for model_id, label in ASR_MODELS.items()],
        "selected_model": MODEL_ID,
        "ready": model_ready,
    }


@app.post("/models/select")
async def choose_asr_model(selection: ModelSelection):
    await run_in_threadpool(select_asr_model, selection.model_id)
    return {
        "selected_model": MODEL_ID,
        "label": ASR_MODELS[MODEL_ID],
        "device": DEVICE,
        "inference_mode": INFERENCE_MODE,
    }


@app.post("/transcribe")
async def transcribe_audio(audio: UploadFile = File(...)):
    audio_bytes = await audio.read(60 * 1024 * 1024 + 1)
    if len(audio_bytes) > 60 * 1024 * 1024:
        logger.warning("Rejected audio upload exceeding 60 MB")
        raise HTTPException(status_code=413, detail="Audio files must be 60 MB or smaller.")
    if not audio_bytes:
        logger.warning("Rejected empty audio upload")
        raise HTTPException(status_code=400, detail="The uploaded audio is empty.")

    logger.info("Received audio upload: %d bytes", len(audio_bytes))
    samples = load_audio(audio_bytes)
    if MODEL_ID == AZURE_MODEL_ID:
        text = await run_in_threadpool(transcribe_with_azure, samples)
        return {"text": text, "language": "ka-GE", "model": AZURE_MODEL_ID}
    return {"text": transcribe(samples), "language": "ka", "model": MODEL_ID}


@app.post("/screen-ocr")
async def screen_ocr(image: UploadFile = File(...)):
    image_bytes = await image.read(OCR_MAX_BYTES + 1)
    if len(image_bytes) > OCR_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Screen captures must be 12 MB or smaller.")
    if not image_bytes:
        raise HTTPException(status_code=400, detail="The screen capture is empty.")

    extracted_text = await run_in_threadpool(extract_screen_text, image_bytes)
    return {"text": extracted_text, "model": "RapidOCR PP-OCRv6 English + PP-OCRv4 Georgian"}