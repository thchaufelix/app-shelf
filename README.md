# Shelf

A local application browser. Drag an app onto the page, tag it, pin it, give it an alternate name, and double-click to open it.

The file name is the default name. An alternate name replaces it until you clear the field. Items live in a local SQLite database. Removing an item does not delete the file.

Shelf runs on macOS and Windows. Node.js 22.13 or newer is required to run from source. There are no packages to install for `npm start`.

## Run

```sh
npm start
```

On Windows, from the project folder:

```bat
npm start
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173). The server binds to localhost only.

### Windows executable

From the project folder, with Node.js 22.13 or newer:

```bat
npm install
npm run dist:win
```

That writes `dist\Shelf.exe`. Double-click it. Node does not need to be installed on the machine that runs the exe. The first launch may show a Windows SmartScreen warning because the file is unsigned.

The exe starts the local server and opens the browser. A console window stays open while it runs; close that window or click **Quit Shelf** to stop it. Closing the browser tab does not stop the server.

Packaged data lives in `%APPDATA%\Shelf` (`shelf.db`, `icons`, `shelf.log`). If you create a `data` folder next to `Shelf.exe`, that folder is used instead.

A second double-click while Shelf is already running only reopens the browser.

Set `SHELF_NO_OPEN=1` to skip opening the browser, or `PORT` to choose another port.

To stop it, press Ctrl+C in that terminal. If it is running in the background:

```sh
kill $(lsof -ti tcp:4173)
```

On Windows:

```bat
for /f "tokens=5" %a in ('netstat -ano ^| findstr :4173 ^| findstr LISTENING') do taskkill /PID %a /F
```

## Use

- Drag applications or files onto the page. On macOS, Shelf can read the Finder drag pasteboard when the browser hides the path. On Windows, it reads the File Explorer or Desktop selection when the browser hides the path, a copied file drop, or a unique match in common folders.
- **Add** opens Finder on macOS, or a Windows file dialog. You can select more than one file on Windows. Application picks start in the Start Menu and accept `.exe` and `.lnk` files.
- You can also paste a full path, such as `C:\Program Files\App\App.exe`.
- Double-click an item to open it. Enter does the same when a tile is focused.
- Select an item to pin it, add tags, or set an alternate name. Leave the alternate name blank to use the file name again.
- Click a tag to filter. Pinned items stay at the top.

When you run from source, data is stored in `data/shelf.db` and icons are cached in `data/icons/`. The Windows exe uses `%APPDATA%\Shelf` unless a `data` folder sits next to `Shelf.exe`.
