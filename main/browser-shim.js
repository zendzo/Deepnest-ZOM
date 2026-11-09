/*
 * Browser shim for Deepnest.
 *
 * The Electron renderer uses Node/Electron APIs directly from index.html and
 * deepnest.js. This file is injected by tools/browser-server.js and provides
 * just enough of those APIs to run the same UI in a normal browser:
 *
 *   require('electron')          IPC bridge + dialogs
 *   require('electron-settings') localStorage
 *   require('graceful-fs')       File API + download
 *   require('request')           fetch('/convert')
 *   require('path'/'url'/'http') small shims
 *
 * It is a no-op in Electron (a real require() exists there).
 */
(function () {
	'use strict';

	if (typeof window === 'undefined') {
		return;
	}
	if (typeof require === 'function') {
		return;
	}

	window.__browserMode = true;

	// Only the actual background.html frame is the worker host. The app itself
	// may also be embedded in an iframe (e.g. the end-to-end smoke test).
	var isBackground = !!(window.parent && window.parent !== window &&
		/\/background\.html$/i.test(window.location.pathname || ''));
	var fileRegistry = {};
	var fileCounter = 0;
	var SETTINGS_PREFIX = 'deepnest.';

	function registerFile(file) {
		var fakePath = '/browser/' + (++fileCounter) + '/' + file.name;
		fileRegistry[fakePath] = file;
		return fakePath;
	}

	function fileForPath(filePath) {
		return fileRegistry[filePath];
	}

	function releaseFile(filePath) {
		delete fileRegistry[filePath];
	}

	// ---------------------------------------------------------------- settings
	function readSetting(key) {
		try {
			var raw = localStorage.getItem(SETTINGS_PREFIX + key);
			return raw == null ? undefined : JSON.parse(raw);
		} catch (error) {
			return undefined;
		}
	}

	function writeSetting(key, value) {
		try {
			localStorage.setItem(SETTINGS_PREFIX + key, JSON.stringify(value));
		} catch (error) {
			// private mode / quota
		}
	}

	function allSettings() {
		var result = {};
		try {
			for (var i = 0; i < localStorage.length; i++) {
				var key = localStorage.key(i);
				if (key && key.indexOf(SETTINGS_PREFIX) === 0) {
					result[key.slice(SETTINGS_PREFIX.length)] = JSON.parse(localStorage.getItem(key));
				}
			}
		} catch (error) {
			return result;
		}
		return result;
	}

	function clearSettings() {
		try {
			var keys = [];
			for (var i = 0; i < localStorage.length; i++) {
				var key = localStorage.key(i);
				if (key && key.indexOf(SETTINGS_PREFIX) === 0) {
					keys.push(key);
				}
			}
			for (var j = 0; j < keys.length; j++) {
				localStorage.removeItem(keys[j]);
			}
		} catch (error) {
			// ignore
		}
	}

	var settings = {
		defaults: function (values) {
			for (var key in values) {
				if (Object.prototype.hasOwnProperty.call(values, key) && readSetting(key) === undefined) {
					writeSetting(key, values[key]);
				}
			}
		},
		getSync: readSetting,
		setSync: writeSetting,
		get: function (key) {
			if (key === undefined || key === null) {
				return Promise.resolve(allSettings());
			}
			return Promise.resolve(readSetting(key));
		},
		set: function (key, value) {
			if (key && typeof key === 'object') {
				for (var name in key) {
					if (Object.prototype.hasOwnProperty.call(key, name)) {
						writeSetting(name, key[name]);
					}
				}
			} else {
				writeSetting(key, value);
			}
			return Promise.resolve();
		},
		resetToDefaultsSync: clearSettings,
		resetToDefaults: function () {
			clearSettings();
			return Promise.resolve();
		}
	};

	// --------------------------------------------------------------------- path
	var pathShim = {
		sep: '/',
		delimiter: ':',
		extname: function (value) {
			var match = /\.[^./\\]+$/.exec(String(value == null ? '' : value));
			return match ? match[0] : '';
		},
		basename: function (value) {
			var text = String(value == null ? '' : value).replace(/\\/g, '/');
			return text.slice(text.lastIndexOf('/') + 1);
		},
		dirname: function (value) {
			var text = String(value == null ? '' : value).replace(/\\/g, '/');
			var index = text.lastIndexOf('/');
			return index >= 0 ? text.slice(0, index) : '.';
		},
		join: function () {
			var parts = Array.prototype.slice.call(arguments);
			return parts.join('/').replace(/\/+/g, '/');
		}
	};

	var urlShim = {
		format: function (value) {
			return value && value.pathname ? value.pathname : '';
		},
		parse: function (value) {
			var anchor = document.createElement('a');
			anchor.href = value;
			return {
				href: anchor.href,
				pathname: anchor.pathname,
				search: anchor.search,
				hash: anchor.hash
			};
		}
	};

	// ----------------------------------------------------------------------- fs
	function readFile(filePath, encoding, callback) {
		if (typeof encoding === 'function') {
			callback = encoding;
			encoding = null;
		}
		var file = fileForPath(filePath);
		if (!file) {
			callback(new Error('File not found: ' + filePath));
			return;
		}

		var reader = new FileReader();
		reader.onerror = function () {
			callback(reader.error || new Error('Could not read ' + filePath));
		};
		reader.onload = function () {
			if (encoding) {
				callback(null, String(reader.result));
			} else {
				callback(null, reader.result);
			}
		};
		if (encoding) {
			reader.readAsText(file);
		} else {
			reader.readAsArrayBuffer(file);
		}
	}

	function download(fileName, data) {
		var name = pathShim.basename(fileName) || 'deepnest-output';
		var blob;
		var lower = name.toLowerCase();

		if (lower.slice(-4) === '.dxf' && typeof data === 'string') {
			// The converter returns a binary DXF string. Write the low byte of
			// each character so non-ASCII bytes survive the Blob conversion.
			var bytes = new Uint8Array(data.length);
			for (var i = 0; i < data.length; i++) {
				bytes[i] = data.charCodeAt(i) & 0xff;
			}
			blob = new Blob([bytes], { type: 'application/dxf' });
		} else if (data instanceof Blob) {
			blob = data;
		} else {
			blob = new Blob([data == null ? '' : data], { type: 'text/plain' });
		}

		var link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		link.download = name;
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
		setTimeout(function () {
			URL.revokeObjectURL(link.href);
		}, 1000);
	}

	var fsShim = {
		readFile: readFile,
		readFileSync: function (filePath, encoding) {
			// Synchronous reads cannot be emulated from a browser File object.
			throw new Error('readFileSync is not available in browser mode: ' + filePath);
		},
		writeFileSync: function (filePath, data) {
			download(filePath, data);
		},
		writeFile: function (filePath, data, callback) {
			download(filePath, data);
			if (callback) {
				callback(null);
			}
		},
		createReadStream: function (filePath) {
			return fileForPath(filePath) || null;
		},
		existsSync: function () {
			return false;
		},
		readdirSync: function () {
			return [];
		},
		unlinkSync: function () {},
		mkdirSync: function () {}
	};

	// ------------------------------------------------------------------ request
	function post(url, callback) {
		var fields = [];
		var scheduled = false;

		function send() {
			var form = new FormData();
			for (var i = 0; i < fields.length; i++) {
				var field = fields[i];
				var value = field.value;
				var fileName = field.options && field.options.filename;

				if (value && typeof value === 'object' && typeof value.name === 'string') {
					form.append(field.name, value, fileName || value.name);
				} else if (field.options && (field.options.filename || field.options.contentType)) {
					// The converter expects fileUpload as a file part, even when
					// the caller passes an in-memory SVG string.
					var blob = new Blob([value == null ? '' : String(value)], {
						type: field.options.contentType || 'application/octet-stream'
					});
					form.append(field.name, blob, field.options.filename || 'upload');
				} else {
					form.append(field.name, value == null ? '' : String(value));
				}
			}

			fetch('/convert', { method: 'POST', body: form })
				.then(function (response) {
					return response.text().then(function (body) {
						if (!response.ok) {
							callback(new Error('Conversion server returned ' + response.status), response, body);
						} else {
							callback(null, response, body);
						}
					});
				})
				.catch(function (error) {
					callback(error);
				});
		}

		return {
			form: function () {
				return {
					append: function (name, value, options) {
						fields.push({ name: name, value: value, options: options });
						if (!scheduled) {
							scheduled = true;
							setTimeout(send, 0);
						}
					}
				};
			}
		};
	}

	var requestShim = {
		post: post,
		get: function () {
			throw new Error('request.get is not used in browser mode');
		}
	};

	// ------------------------------------------------------------------- dialogs
	function extensionForTitle(title) {
		var text = String(title || '').toUpperCase();
		if (text.indexOf('DXF') >= 0) {
			return '.dxf';
		}
		if (text.indexOf('GCODE') >= 0) {
			return '.gcode';
		}
		return '.svg';
	}

	var dialogShim = {
		showOpenDialog: function (options, callback) {
			var input = document.createElement('input');
			input.type = 'file';
			input.style.display = 'none';

			var properties = options && options.properties ? options.properties : [];
			input.multiple = properties.indexOf('multiSelections') >= 0;

			var extensions = [];
			if (options && options.filters) {
				for (var i = 0; i < options.filters.length; i++) {
					var filter = options.filters[i];
					if (filter && filter.extensions) {
						extensions = extensions.concat(filter.extensions);
					}
				}
			}
			if (extensions.length > 0) {
				input.accept = extensions.map(function (extension) {
					return '.' + String(extension).replace(/^\./, '');
				}).join(',');
			}

			var settled = false;
			function finish(filePath) {
				if (settled) {
					return;
				}
				settled = true;
				window.removeEventListener('focus', onFocus);
				if (input.parentNode) {
					input.parentNode.removeChild(input);
				}
				callback(filePath);
			}

			function onFocus() {
				setTimeout(function () {
					if (!settled && (!input.files || input.files.length === 0)) {
						finish(undefined);
					}
				}, 400);
			}

			input.onchange = function () {
				if (!input.files || input.files.length === 0) {
					finish(undefined);
					return;
				}

				var paths = [];
				for (var i = 0; i < input.files.length; i++) {
					paths.push(registerFile(input.files[i]));
				}
				finish(paths);
			};

			document.body.appendChild(input);
			window.addEventListener('focus', onFocus);
			input.click();
		},
		showSaveDialog: function (options, callback) {
			// Writing triggers a download; only the extension matters here.
			callback('deepnest' + extensionForTitle(options && options.title));
		}
	};

	// ----------------------------------------------------------------------- IPC
	var handlers = {};
	var pending = [];
	var backgroundFrame = null;
	var backgroundReady = false;

	var ipcRenderer = {
		on: function (channel, listener) {
			if (!handlers[channel]) {
				handlers[channel] = [];
			}
			handlers[channel].push(listener);
		},
		removeListener: function (channel, listener) {
			var list = handlers[channel];
			if (!list) {
				return;
			}
			var index = list.indexOf(listener);
			if (index >= 0) {
				list.splice(index, 1);
			}
		},
		send: function (channel, payload) {
			if (isBackground) {
				window.parent.postMessage({ __deepnest: true, channel: channel, payload: payload }, '*');
				return;
			}
			if (channel === 'background-stop') {
				resetBackground();
				return;
			}
			if (!backgroundFrame || !backgroundReady) {
				pending.push({ channel: channel, payload: payload });
				return;
			}
			backgroundFrame.contentWindow.postMessage({
				__deepnest: true,
				channel: channel,
				payload: payload
			}, '*');
		},
		sendSync: function () {
			return null;
		}
	};

	function dispatch(channel, payload) {
		var list = handlers[channel];
		if (!list) {
			return;
		}
		for (var i = 0; i < list.length; i++) {
			list[i]({}, payload);
		}
	}

	window.addEventListener('message', function (event) {
		var data = event.data;
		if (!data || !data.__deepnest) {
			return;
		}
		if (data.channel === 'browser-error') {
			console.error('Deepnest background error:', data.payload);
			return;
		}
		if (data.channel === 'browser-ready') {
			backgroundReady = true;
			flushPending();
			return;
		}
		dispatch(data.channel, data.payload);
	});

	if (isBackground) {
		window.addEventListener('error', function (event) {
			window.parent.postMessage({
				__deepnest: true,
				channel: 'browser-error',
				payload: {
					message: event.message,
					source: event.filename,
					line: event.lineno,
					stack: event.error && event.error.stack
				}
			}, '*');
		});
		window.addEventListener('unhandledrejection', function (event) {
			window.parent.postMessage({
				__deepnest: true,
				channel: 'browser-error',
				payload: {
					message: String(event.reason && event.reason.message || event.reason),
					stack: event.reason && event.reason.stack
				}
			}, '*');
		});
	}

	function flushPending() {
		var queued = pending;
		pending = [];
		for (var i = 0; i < queued.length; i++) {
			ipcRenderer.send(queued[i].channel, queued[i].payload);
		}
	}

	function resetBackground() {
		pending = [];
		backgroundReady = false;
		if (backgroundFrame) {
			var source = backgroundFrame.src;
			backgroundFrame.src = 'about:blank';
			setTimeout(function () {
				backgroundFrame.src = source;
			}, 50);
		}
	}

	function createBackgroundFrame() {
		if (isBackground || backgroundFrame) {
			return;
		}
		backgroundFrame = document.createElement('iframe');
		backgroundFrame.style.display = 'none';
		backgroundFrame.src = '/main/background.html';
		document.body.appendChild(backgroundFrame);
	}

	// Chrome exposes performance.memory; give background.js a safe value if a
	// browser does not.
	if (!window.performance) {
		window.performance = {};
	}
	if (!window.performance.memory) {
		window.performance.memory = { totalJSHeapSize: 0, jsHeapSizeLimit: 1 };
	}

	var remoteApi = {
		dialog: dialogShim,
		require: function () {
			return {};
		},
		BrowserWindow: function () {},
		getCurrentWindow: function () {
			return { on: function () {}, webContents: {} };
		}
	};

	var appApi = {
		dialog: dialogShim,
		require: function () {
			return {};
		},
		BrowserWindow: function () {},
		getPath: function () {
			return '/browser';
		},
		quit: function () {
			window.close();
		}
	};

	function PackageJson() {
		return { name: 'Deepnest.io', version: '1.0.5' };
	}

	function FileQueue() {}
	FileQueue.prototype.writeFile = function (filePath, data, callback) {
		if (callback) {
			callback(null);
		}
	};

	window.require = function (name) {
		switch (name) {
			case 'electron':
				return {
					ipcRenderer: ipcRenderer,
					remote: remoteApi,
					app: appApi,
					BrowserWindow: function () {}
				};
			case 'electron-settings':
			case 'electron-config':
				return settings;
			case 'graceful-fs':
			case 'fs':
				return fsShim;
			case 'request':
				return requestShim;
			case 'http':
				return {
					request: function () {
						throw new Error('http.request is not used in browser mode');
					}
				};
			case 'path':
				return pathShim;
			case 'url':
				return urlShim;
			case 'filequeue':
				return FileQueue;
			case '../package.json':
				return new PackageJson();
			case '../minkowski/Release/addon':
				return {
					calculateNFP: function (payload) {
						if (window.__nfpAddon && window.__nfpAddon.calculateNFP) {
							return window.__nfpAddon.calculateNFP(payload);
						}
						throw new Error('JavaScript NFP fallback is not loaded');
					}
				};
			default:
				return {};
		}
	};

	// Exposed for the browser smoke test and debugging; never used by the app.
	if (!isBackground) {
		window.__browserShim = {
			registerFile: registerFile,
			releaseFile: releaseFile,
			files: fileRegistry,
			ipcRenderer: ipcRenderer,
			settings: settings,
			fs: fsShim,
			request: requestShim
		};
	}

	if (!isBackground) {
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', createBackgroundFrame);
		} else {
			createBackgroundFrame();
		}
	} else {
		// background.js registers its IPC listener in window.onload. Wait until
		// after that handler has run before telling the parent we are ready.
		window.addEventListener('load', function () {
			setTimeout(function () {
				window.parent.postMessage({ __deepnest: true, channel: 'browser-ready' }, '*');
			}, 0);
		});
	}
})();
