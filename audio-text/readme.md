This folder is for all georgian to text related processing and models : 

Implementation details : 
- We will be taking audio sources as input (Georgian)
- Output from this system will be text (Georgian)

## Local implementation

- Default model: [BuzzASR Georgian](https://huggingface.co/BuzzASR/georgian), a Georgian-only MIT-licensed model fine-tuned from Whisper large-v3.
- Local API setup and run instructions: [server/README.md](server/README.md)
- Browser extension setup: [web-extension/readme.md](../web-extension/readme.md)
- Existing experiment: [POC/Audio-Text-Model.ipynb](POC/Audio-Text-Model.ipynb)
