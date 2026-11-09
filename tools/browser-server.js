/*
 * Zero-dependency development server for the browser build.
 *
 *   node tools/browser-server.js [--port 8080] [--host 127.0.0.1]
 *
 * It serves the repository and proxies POST /convert to convert.deepnest.io.
 * The proxy exists because the converter does not send CORS headers, so a
 * browser cannot call it directly.
 */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var UPSTREAM = {
	hostname: 'convert.deepnest.io',
	port: 80,
	path: '/',
	method: 'POST'
};

var MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.eot': 'application/vnd.ms-fontobject',
	'.dxf': 'application/dxf',
	'.nc1': 'text/plain; charset=latin1',
	'.dstv': 'text/plain; charset=latin1'
};

function parseArgs(argv) {
	var result = { port: 8080, host: '127.0.0.1' };
	for (var i = 2; i < argv.length; i++) {
		if (argv[i] === '--port' && argv[i + 1]) {
			result.port = parseInt(argv[++i], 10);
		} else if (argv[i] === '--host' && argv[i + 1]) {
			result.host = argv[++i];
		}
	}
	return result;
}

function send(res, status, contentType, body, extraHeaders) {
	var headers = {
		'Content-Type': contentType,
		'Cache-Control': 'no-store',
		'Access-Control-Allow-Origin': '*'
	};
	if (extraHeaders) {
		for (var key in extraHeaders) {
			headers[key] = extraHeaders[key];
		}
	}
	res.writeHead(status, headers);
	res.end(body);
}

function injectBrowserScripts(html, isBackground) {
	var shim = '<script src="/browser-shim.js"></script>';
	var nfp = isBackground ? '<script src="/browser-nfp.js"></script>' : '';
	var index = html.search(/<script\b/i);

	if (index < 0) {
		index = html.search(/<\/head>/i);
	}
	if (index < 0) {
		index = 0;
	}
	html = html.slice(0, index) + shim + html.slice(index);

	if (nfp) {
		var end = html.search(/<\/head>/i);
		if (end < 0) {
			end = html.length;
		}
		html = html.slice(0, end) + nfp + html.slice(end);
	}
	return html;
}

function serveHtml(filePath, isBackground, res) {
	fs.readFile(filePath, 'utf8', function (error, html) {
		if (error) {
			send(res, 404, 'text/plain; charset=utf-8', 'Not found');
			return;
		}
		send(res, 200, MIME['.html'], injectBrowserScripts(html, isBackground));
	});
}

function serveStatic(pathname, res) {
	var filePath;
	if (pathname === '/') {
		res.writeHead(302, { Location: '/main/index.html' });
		res.end();
		return;
	}
	if (pathname === '/main' || pathname === '/main/') {
		res.writeHead(302, { Location: '/main/index.html' });
		res.end();
		return;
	}
	if (pathname === '/browser-shim.js') {
		filePath = path.join(ROOT, 'main', 'browser-shim.js');
	} else if (pathname === '/browser-nfp.js') {
		filePath = path.join(ROOT, 'main', 'browser', 'nfp.js');
	} else {
		filePath = path.join(ROOT, pathname.replace(/^\/+/, ''));
	}

	var resolved = path.resolve(filePath);
	if (resolved.indexOf(path.resolve(ROOT) + path.sep) !== 0) {
		send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
		return;
	}

	var extension = path.extname(resolved).toLowerCase();
	var base = path.basename(resolved).toLowerCase();

	if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
		send(res, 404, 'text/plain; charset=utf-8', 'Not found: ' + pathname);
		return;
	}

	if (extension === '.html') {
		serveHtml(resolved, base === 'background.html', res);
		return;
	}

	res.writeHead(200, {
		'Content-Type': MIME[extension] || 'application/octet-stream',
		'Cache-Control': 'no-store'
	});
	fs.createReadStream(resolved).pipe(res);
}

function proxyConvert(req, res) {
	if (req.method === 'OPTIONS') {
		send(res, 204, 'text/plain; charset=utf-8', '');
		return;
	}
	if (req.method !== 'POST') {
		send(res, 405, 'text/plain; charset=utf-8', 'error: POST required');
		return;
	}

	var chunks = [];
	req.on('data', function (chunk) {
		chunks.push(chunk);
	});
	req.on('end', function () {
		var body = Buffer.concat(chunks);
		var headers = {
			'Content-Type': req.headers['content-type'] || 'application/octet-stream',
			'Content-Length': body.length,
			'User-Agent': 'deepnest-browser-proxy'
		};

		var upstreamRequest = http.request({
			hostname: UPSTREAM.hostname,
			port: UPSTREAM.port,
			path: UPSTREAM.path,
			method: UPSTREAM.method,
			headers: headers,
			timeout: 120000
		}, function (upstreamResponse) {
			var responseChunks = [];
			upstreamResponse.on('data', function (chunk) {
				responseChunks.push(chunk);
			});
			upstreamResponse.on('end', function () {
				var responseBody = Buffer.concat(responseChunks);
				send(
					res,
					upstreamResponse.statusCode || 502,
					upstreamResponse.headers['content-type'] || 'application/octet-stream',
					responseBody
				);
			});
		});

		upstreamRequest.on('timeout', function () {
			upstreamRequest.destroy(new Error('Converter request timed out'));
		});
		upstreamRequest.on('error', function (error) {
			send(res, 502, 'text/plain; charset=utf-8', 'error: ' + error.message);
		});
		upstreamRequest.end(body);
	});
}

var args = parseArgs(process.argv);

var server = http.createServer(function (req, res) {
	var parsed = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
	var pathname = decodeURIComponent(parsed.pathname || '/');

	if (pathname === '/convert') {
		proxyConvert(req, res);
		return;
	}
	if (pathname === '/health') {
		send(res, 200, 'text/plain; charset=utf-8', 'ok');
		return;
	}

	serveStatic(pathname, res);
});

server.listen(args.port, args.host, function () {
	console.log('Deepnest browser mode: http://' + args.host + ':' + args.port + '/main/index.html');
	console.log('Converter proxy:      http://' + args.host + ':' + args.port + '/convert');
});
