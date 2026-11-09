/*
 * Import worker: NC1/DSTV parsing and DXF TEXT metadata scans.
 *
 * Loaded as a classic worker by main/index.html so these stages run off the
 * UI thread. The scripts it imports are plain UMD modules with no DOM
 * dependencies:
 *   - nc1.js       parseNc1 + nc1ToSvg
 *   - dxf-meta.js  parseDxfMeta
 *
 * Message in:
 *   { type: 'nc1', name, buffer }        buffer: ArrayBuffer/Uint8Array
 *   { type: 'dxf-meta', name, text }     text: DXF file contents
 *
 * Message out:
 *   { ok: true, svg, meta, warnings, timings }        for nc1
 *   { ok: true, meta, timings }                       for dxf-meta
 *   { ok: false, error }
 *
 * Timings are measured here so the main-thread profiler can record
 * nc1.parse / nc1.toSvg / dxf.meta even when the work is off-thread.
 */
'use strict';

importScripts('nc1.js', 'dxf-meta.js');

function now() {
	if (typeof performance !== 'undefined' && performance.now) {
		return performance.now();
	}
	return Date.now();
}

function nc1Meta(parsed) {
	return {
		mark: parsed.mark,
		quantity: parsed.header.quantity,
		material: parsed.header.material,
		thickness: parsed.header.thickness,
		profile: parsed.header.profile,
		warnings: parsed.warnings,
		source: 'nc1'
	};
}

self.onmessage = function (event) {
	var message = event.data || {};
	var timings = {};

	try {
		if (message.type === 'nc1') {
			var parseStart = now();
			var parsed = Nc1.parseNc1(message.buffer, message.name);
			timings.parse = now() - parseStart;

			var renderStart = now();
			var rendered = Nc1.nc1ToSvg(parsed, { curveTolerance: 0.1 });
			timings.toSvg = now() - renderStart;

			self.postMessage({
				ok: true,
				svg: rendered.svg,
				meta: nc1Meta(parsed),
				warnings: parsed.warnings,
				timings: timings
			});
			return;
		}

		if (message.type === 'dxf-meta') {
			var metaStart = now();
			var meta = DxfMeta.parseDxfMeta(message.text);
			timings.meta = now() - metaStart;

			self.postMessage({
				ok: true,
				meta: meta,
				timings: timings
			});
			return;
		}

		self.postMessage({
			ok: false,
			error: 'Unknown import worker task: ' + message.type
		});
	}
	catch (error) {
		self.postMessage({
			ok: false,
			error: String(error && error.message ? error.message : error)
		});
	}
};
