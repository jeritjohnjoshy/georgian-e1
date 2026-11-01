# Georgian Audio Typing

Chrome Manifest V3 extension for Georgian audio transcription and screen text extraction, with local processing and editable review before typing.

## Run

1. Start the server using [audio-text/server/README.md](../audio-text/server/README.md).
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**. Select this `web-extension` folder.
3. Open a normal `http://` or `https://` page and click the extension icon. Choose **Test** beside **Local server** to check the API and model status.
4. Choose **Open overlay**, then **Set text field**. If the caret is already in a supported field, it selects that field; otherwise click the chat field on the page. Choose **Whisper large-v3 Turbo** or **BuzzASR Georgian** in the **Audio model** selector before listening.
5. In the overlay choose **Start listening**, then play the voice message in the same tab. Choose **Stop recording** when the message ends.
6. Choose **Generate text** to transcribe the captured audio locally. Edit the Georgian draft in the overlay if needed, then choose **Type into chat** to enter it in the selected field.
7. Choose **Read chat text**, move over the Lingwing text until it is outlined, then click it. The clicked item appears in the editable draft and is typed into the answer field automatically. Press `Escape` to cancel the picker.
8. For text rendered as an image or canvas, choose **Extract screen text** and drag a box around it. The OCR result appears in the editable draft in its original language; review it, then choose **Type into chat**.

The extension records only the active tab's audio after you choose **Start listening**. It records until you choose **Stop recording**, with a three-minute safety limit. It routes the captured stream back to the tab so playback remains audible. The transcription request goes only to `http://127.0.0.1:8000`.

For screen OCR, only the crop inside the selection rectangle is sent to the local server. Press `Escape` to cancel the selection. Clicked page text is read directly by the content script and is not sent to a server.

## Notes and limits

- Chrome's tab-capture indicator is shown while capture is active. The extension cannot capture arbitrary system audio or a different tab.
- Text entry sends browser-level key events one character at a time with a 75 ms pause (`TYPE_DELAY_MS` in `service-worker.js`) and does not use the clipboard. Adjust that constant to change the cadence. Chrome's `debugger` permission is used only while typing and is detached immediately afterward; Chrome displays its debugging indicator during that time. Typing may fail while DevTools or another debugger is attached to the tab.
- Password fields and non-editable controls are intentionally unsupported.
- Chrome internal pages, the Chrome Web Store, and some cross-origin embedded frames do not allow content-script overlays.
- Start the local server before transcribing. The extension reports server errors in the overlay.