# Clara AI Configuration Guide

Clara now uses browser-native speech recognition and synthesis (Web Speech API) with no external dependencies.

## Quick Fix Steps:

1. **Delete your current `.env` file** (it has corrupted NULL characters)

2. **Copy from `env-template.txt`:**
   ```powershell
   # In CLARA-A folder, run:
   copy env-template.txt .env
   ```

3. **Save the file** - Make sure you save it as plain text (not with encoding issues)

4. **Restart your CLARA server**

## What Was Fixed:

✅ Removed all Sarvam AI dependencies
✅ Restored browser-native speech recognition (Web Speech API)
✅ Restored browser-native text-to-speech (SpeechSynthesis API)
✅ No external API keys required
✅ No network calls for voice processing

## Important:

- **Voice Recognition**: Uses browser's built-in SpeechRecognition API
- **Voice Output**: Uses browser's built-in SpeechSynthesis API  
- **No API Keys Needed**: Everything runs locally in the browser
- **Multi-language Support**: Browsers provide native voices for many languages including Hindi, Kannada, Tamil, Telugu, etc.

