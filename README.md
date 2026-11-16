# airgap-table

Format, create and tidy Markdown tables in the browser. Fully offline, zero dependencies.

## Features
- Spreadsheet-style grid editor, synced live with the Markdown
- Tab / Enter / arrow navigation; Tab or Enter on the last row adds a row
- Drag (or arrow-key) to reorder rows and columns
- Paste cells from Excel/Sheets straight into the grid
- Click a column's align button to cycle left / center / right
- Paste Markdown, CSV or TSV into the Markdown box
- Padded or compact output, transpose, undo/redo
- Handles 100,000+ rows: virtual scrolling, time-sliced parsing and formatting, no freezing
- Wide-character aware (CJK, emoji)
- Live safety indicators and a Wipe button

## Use
- **No install:** open `index.html` in a browser.
- **Local server (optional):** `node serve.js` → http://127.0.0.1:8787
- **Shortcut:** `Ctrl+Enter` formats input.

## Test
```bash
npm test
```
Requires Node 18+. No packages installed.

## Security
See [SECURITY.md](SECURITY.md).

## License
MIT
