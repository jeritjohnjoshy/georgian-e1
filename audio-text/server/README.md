# Local Georgian transcription server

The API runs locally with an ASR model selected from the extension. The current test default is [`openai/whisper-large-v3-turbo`](https://huggingface.co/openai/whisper-large-v3-turbo); [`BuzzASR/georgian`](https://huggingface.co/BuzzASR/georgian) remains available for accuracy comparisons. Azure Speech Georgian (`ka-GE`) can optionally be enabled as a cloud model; it is not used unless selected. BuzzASR is Georgian-specialized and its model card reports 12.54% combined normalized CER and 19.43% WER on FLEURS/Common Voice. Compare both local models against your own audio before choosing a default.

## Run

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) first. The project is configured for Python 3.10–3.13; Python 3.15 is intentionally excluded because some model dependencies do not yet provide compatible wheels. From this directory:

```powershell
uv python install 3.13
uv sync --python 3.13
uv run uvicorn main:app --host 127.0.0.1 --port 8000
```

### Enable Azure Speech F0

1. In the [Azure portal](https://portal.azure.com/), create a **Speech** resource. Choose the **F0** pricing tier and a region that supports Georgian speech-to-text (`ka-GE`). Azure currently lists 5 hours of free real-time transcription per month; verify the allowance and region availability on the [pricing page](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/).
2. In the resource's **Keys and Endpoint** page, copy a key and the resource region.
3. In PowerShell, set the credentials in the same terminal that will run the server, then install the SDK dependency and start the API:

	```powershell
	$env:AZURE_SPEECH_KEY = "<your-key>"
	$env:AZURE_SPEECH_REGION = "<your-resource-region>"
	uv sync --python 3.13
	uv run uvicorn main:app --host 127.0.0.1 --port 8000
	```

4. Open the extension and choose **Azure Speech Georgian (cloud, F0 eligible)** in the **Audio model** selector. The recording is sent from the local server to Azure only when this model is selected. Keep the key in the server environment; never put it in the extension files or share it.

If the Azure choice is not listed, confirm both environment variables are set and restart the server. They are read at server startup. Azure Speech uses the configured region and Georgian locale `ka-GE`; the F0 free allowance is shared across Standard and Custom real-time speech-to-text and does not include batch transcription.

`uv sync` creates and manages the `.venv` environment from `pyproject.toml`. On CPU, the server defaults to dynamic int8 quantization for linear layers and uses all available CPU threads. This reduces model memory and can improve inference speed; compare transcript quality with your own audio. Set `ASR_CPU_INT8=0` to use float32 if quantization is unsupported or reduces accuracy too much. Set `ASR_CPU_THREADS=8` (for example) to tune CPU thread count. `/health` reports the active `inference_mode` and thread count.

For NVIDIA GPU inference, use the [official PyTorch selector](https://pytorch.org/get-started/locally/) to choose the matching CUDA build, then verify it inside the environment with `uv run python -c "import torch; print(torch.cuda.is_available())"`. GPU inference uses float16 and avoids CPU quantization. The model weights are downloaded from Hugging Face on first startup and kept in memory while the server runs.

## Screen OCR

`POST /screen-ocr` accepts a selected-screen-region PNG as multipart field `image`. It runs an English-capable PP-OCRv6 recognizer and a Georgian (`ka`) PP-OCRv4 recognizer over the crop, then combines detected English and Georgian lines in reading order. Both OCR engines initialize lazily and download their model files on first use; subsequent OCR runs locally.

The extension sends only the user-selected crop to this local endpoint and places the extracted text in the editable draft. Review OCR output before typing, especially when text is small, stylized, or partly obscured.

## Model choices

- English and Georgian OCR: [RapidOCR](https://github.com/RapidAI/RapidOCR), Apache-2.0 source and model artifacts, using PP-OCRv6 English and PP-OCRv4 Georgian (`ka`) recognizers with ONNX Runtime.
- Georgian ASR accuracy: [`BuzzASR/georgian`](https://huggingface.co/BuzzASR/georgian), MIT, Georgian-specialized, and reports lower Georgian error rates than Whisper zero-shot.
- Whisper Turbo comparison: [`openai/whisper-large-v3-turbo`](https://huggingface.co/openai/whisper-large-v3-turbo), MIT and 809M parameters versus BuzzASR's 2B. Its model card reports lower latency but no directly comparable Georgian-specific evaluation.

Check `http://127.0.0.1:8000/health` for readiness. `POST /transcribe` accepts an `audio` multipart file; Chrome's WebM/Opus recording is decoded and resampled to mono 16 kHz. Long recordings are transcribed in 28-second chunks.

`GET /models` returns the available ASR models and current selection. `POST /models/select` accepts `{"model_id":"openai/whisper-large-v3-turbo"}`, `{"model_id":"BuzzASR/georgian"}`, or (when configured) `{"model_id":"azure/speech-ka-GE"}`. The extension exposes this choice before recording; selecting a different local model loads its weights, while selecting Azure unloads local weights and sends only the recorded audio to the cloud provider.

The server binds to loopback only. Do not change the host to `0.0.0.0` unless you add authentication and understand the exposure. With either local model selected, audio stays on this computer; with Azure selected, audio passes through the local server and is sent to Azure Speech for transcription.