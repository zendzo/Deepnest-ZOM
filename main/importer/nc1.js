/*
 * Nc1
 * Tekla DSTV/NC1 plate parser and SVG generator.
 *
 * Ported from the Python reference in autonest-SMOE:
 *   importers/dstv_nc1.py
 *
 * The reference converts NC1 to DXF. This module keeps the same parsing rules
 * and emits SVG instead, because Deepnest's importer already understands SVG.
 * Arc segments are sampled to polylines at a configurable chord tolerance; the
 * nesting engine approximates curves anyway, so this keeps one geometry path.
 *
 * Works as a plain browser script (window.Nc1) and as a Node module.
 */
(function (root, factory) {
	var api = factory();
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
	if (root) {
		root.Nc1 = api;
	}
})(typeof self !== 'undefined' ? self : (typeof global !== 'undefined' ? global : this), function () {
	'use strict';

	var PI = Math.PI;
	var ARC_TOLERANCE_MM = 0.01;
	var NUMERIC_CHARS = '0123456789+-.eE';
	var PROFILE_THICKNESS = /^PL\s*([0-9]+(?:\.[0-9]+)?)/i;
	var QUANTITY_RE = /[0-9]+/;

	function Nc1Error(message) {
		this.name = 'Nc1Error';
		this.message = message;
	}
	Nc1Error.prototype = Object.create(Error.prototype);
	Nc1Error.prototype.constructor = Nc1Error;

	function warning(code, message) {
		return { code: code, message: message, severity: 'warning' };
	}

	function toBytes(content) {
		if (content == null || typeof content === 'string') {
			return null;
		}
		if (typeof Uint8Array !== 'undefined' && content instanceof Uint8Array) {
			return content;
		}
		if (typeof ArrayBuffer !== 'undefined' && content instanceof ArrayBuffer) {
			return new Uint8Array(content);
		}
		if (content.buffer && typeof ArrayBuffer !== 'undefined' && content.buffer instanceof ArrayBuffer) {
			return new Uint8Array(content.buffer, content.byteOffset || 0, content.byteLength || content.length);
		}
		return null;
	}

	// DSTV is a 7-bit format. latin-1 never fails, so one odd byte cannot abort
	// a whole batch (same reason as the Python reference).
	function decodeLatin1(content) {
		if (typeof content === 'string') {
			return content;
		}
		var bytes = toBytes(content);
		if (!bytes) {
			return String(content == null ? '' : content);
		}
		var result = '';
		var chunk = 8192;
		for (var i = 0; i < bytes.length; i += chunk) {
			result += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
		}
		return result;
	}

	function splitLines(text) {
		return String(text == null ? '' : text).split(/\r\n|\r|\n/);
	}

	function trimLines(lines) {
		var result = [];
		for (var i = 0; i < lines.length; i++) {
			result.push(lines[i].trim());
		}
		return result;
	}

	// The LISP flushes a number token on any character outside its numeric set.
	// That is what makes "v  6897.5u  2950.0" work: the 'u' marker simply ends
	// the current number.
	function numbers(line) {
		var result = [];
		var token = '';
		var text = String(line == null ? '' : line);
		for (var i = 0; i < text.length; i++) {
			var character = text.charAt(i);
			if (NUMERIC_CHARS.indexOf(character) >= 0) {
				token += character;
				continue;
			}
			if (token) {
				var value = parseFloat(token);
				if (isFinite(value)) {
					result.push(value);
				}
				token = '';
			}
		}
		if (token) {
			var tail = parseFloat(token);
			if (isFinite(tail)) {
				result.push(tail);
			}
		}
		return result;
	}

	function isBlockCode(line) {
		var value = String(line || '').trim().toUpperCase();
		if (value.length < 2 || value.length > 3) {
			return false;
		}
		for (var i = 0; i < value.length; i++) {
			var c = value.charAt(i);
			if (c < 'A' || c > 'Z') {
				return false;
			}
		}
		return true;
	}

	function sameXY(a, b, tolerance) {
		tolerance = tolerance == null ? 1e-8 : tolerance;
		return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;
	}

	function dropClosingPoint(points) {
		if (points.length > 1 && sameXY(points[0], points[points.length - 1])) {
			return points.slice(0, points.length - 1);
		}
		return points.slice(0);
	}

	function parseQuantity(value) {
		var match = QUANTITY_RE.exec(String(value || ''));
		if (!match) {
			return { quantity: 1, valid: false };
		}
		var quantity = parseInt(match[0], 10);
		if (!isFinite(quantity) || quantity < 1) {
			return { quantity: 1, valid: false };
		}
		return { quantity: quantity, valid: true };
	}

	function profileThickness(profile) {
		var match = PROFILE_THICKNESS.exec(String(profile || '').trim());
		if (!match) {
			return null;
		}
		var thickness = parseFloat(match[1]);
		return isFinite(thickness) && thickness > 0 ? thickness : null;
	}

	function sectionFromItem(item) {
		var marker = String(item || '').toUpperCase().indexOf('-PL');
		return marker > 0 ? item.slice(0, marker) : item;
	}

	function headerValue(lines, position, offset) {
		var index = position + offset;
		return index >= 0 && index < lines.length ? lines[index] : '';
	}

	function parseHeader(lines) {
		var position = -1;
		for (var i = 0; i < lines.length; i++) {
			if (lines[i].toUpperCase() === 'ST') {
				position = i;
				break;
			}
		}
		if (position < 0) {
			throw new Nc1Error("File has no DSTV 'ST' header line.");
		}

		var warnings = [];
		var project = headerValue(lines, position, 2);
		var lot = headerValue(lines, position, 3);
		var phase = headerValue(lines, position, 4);
		var assembly = headerValue(lines, position, 5);
		var material = headerValue(lines, position, 6);
		var quantityRaw = headerValue(lines, position, 7);
		var profile = headerValue(lines, position, 8);

		var item = assembly || lot;
		if (!assembly) {
			warnings.push(warning(
				'NC1_NO_ASSEMBLY_POSITION',
				'ST header has no assembly position (+5); the lot/part number is used as the part mark.'
			));
		}
		if (!material) {
			warnings.push(warning(
				'NC1_NO_MATERIAL',
				'ST header has no material (+6); Grade must be reviewed manually.'
			));
		}

		var quantityResult = parseQuantity(quantityRaw);
		if (!quantityResult.valid) {
			warnings.push(warning(
				'NC1_QUANTITY_INVALID',
				'ST header quantity ' + JSON.stringify(quantityRaw) + ' is not a positive integer; quantity 1 is used.'
			));
		}

		var thickness = profileThickness(profile);
		if (thickness == null) {
			warnings.push(warning(
				'NC1_PROFILE_NOT_PLATE',
				'Profile ' + JSON.stringify(profile) + ' is not a PL plate profile; Thickness must be reviewed manually.'
			));
		}

		return {
			header: {
				project: project,
				lot: lot,
				phase: phase,
				item: item,
				material: material,
				quantity: quantityResult.quantity,
				profile: profile,
				thickness: thickness,
				section: sectionFromItem(item)
			},
			warnings: warnings
		};
	}

	function parseBoRecord(line, warnings) {
		var values = numbers(line);
		if (values.length < 4) {
			return null;
		}

		var x = values[0];
		var y = values[1];
		var diameter = Math.abs(values[2]);
		var depth = values[3];
		var radius = diameter / 2;

		if (depth > 1e-8) {
			warnings.push(warning(
				'NC1_BO_DEPTH',
				'BO countersink / incomplete hole depth detected; the 2D outline uses the nominal diameter.'
			));
		}

		if (values.length >= 7) {
			var width = Math.abs(values[4]);
			var height = Math.abs(values[5]);
			var angle = values[6] * PI / 180;
			if (width > height && height > 1e-8) {
				radius = height / 2;
				var halfStraight = (width - height) / 2;
				var cosine = Math.cos(angle);
				var sine = Math.sin(angle);
				// Vertex order copied from the LISP, which the writer reverses
				// again before emitting the polyline.
				var first = {
					x: x + (-halfStraight) * cosine + (-radius) * (-sine),
					y: y + (-halfStraight) * sine + (-radius) * cosine,
					radius: -radius
				};
				var second = {
					x: x + halfStraight * cosine + (-radius) * (-sine),
					y: y + halfStraight * sine + (-radius) * cosine,
					radius: 0
				};
				var third = {
					x: x + halfStraight * cosine + radius * (-sine),
					y: y + halfStraight * sine + radius * cosine,
					radius: -radius
				};
				var fourth = {
					x: x + (-halfStraight) * cosine + radius * (-sine),
					y: y + (-halfStraight) * sine + radius * cosine,
					radius: 0
				};
				return { code: 'BOS', points: [fourth, third, second, first, fourth] };
			}
			warnings.push(warning(
				'NC1_BO_SLOT_INVALID',
				'BO extended record is not a valid width>height slot (width=' + width + ', height=' + height + '); the record is skipped.'
			));
			return null;
		}

		if (radius <= 1e-8) {
			return null;
		}

		// Two diameter ends plus the closing copy of the first point: the writer
		// drops the duplicate and the two semicircle bulges close the circle.
		return {
			code: 'BOC',
			points: [
				{ x: x - radius, y: y, radius: -radius },
				{ x: x + radius, y: y, radius: -radius },
				{ x: x - radius, y: y, radius: 0 }
			]
		};
	}

	function parseContours(lines) {
		var contours = [];
		var warnings = [];
		var block = null;
		var points = [];

		function flush() {
			if ((block === 'AK' || block === 'IK') && points.length > 0) {
				var cleaned = dropClosingPoint(points);
				if (cleaned.length >= 2) {
					contours.push({ code: block, points: cleaned });
				} else {
					warnings.push(warning(
						'NC1_CONTOUR_TOO_SHORT',
						block + ' contour has fewer than two distinct points and was skipped.'
					));
				}
			}
			block = null;
			points = [];
		}

		for (var i = 0; i < lines.length; i++) {
			var line = lines[i];
			var upper = line.toUpperCase();

			if (upper === 'AK' || upper === 'IK' || upper === 'BO') {
				flush();
				block = upper;
				points = [];
				continue;
			}
			if (upper === 'EN' || isBlockCode(line)) {
				// Any other 2-3 letter code (SI stamp text, profile block, ...)
				// ends the current block.
				flush();
				continue;
			}
			if (block === 'BO') {
				var contour = parseBoRecord(line, warnings);
				if (contour) {
					contours.push(contour);
				}
				continue;
			}
			if (block) {
				var values = numbers(line);
				if (values.length >= 2) {
					points.push({
						x: values[0],
						y: values[1],
						radius: values.length >= 3 ? values[2] : 0
					});
				}
			}
		}
		flush();

		return { contours: contours, warnings: warnings };
	}

	function parseNc1(content, filename) {
		var text = decodeLatin1(content).replace(/^\uFEFF/, '');
		if (!text || !text.trim()) {
			throw new Nc1Error('File is empty.');
		}

		var lines = trimLines(splitLines(text));
		var headerResult = parseHeader(lines);
		var contourResult = parseContours(lines);
		var warnings = headerResult.warnings.concat(contourResult.warnings);

		if (contourResult.contours.length === 0) {
			throw new Nc1Error('No AK/IK/BO contour could be read; the file has no usable geometry.');
		}
		var hasOuter = false;
		for (var i = 0; i < contourResult.contours.length; i++) {
			if (contourResult.contours[i].code === 'AK') {
				hasOuter = true;
				break;
			}
		}
		if (!hasOuter) {
			throw new Nc1Error('No AK outer contour found; a part without an outer contour cannot be nested.');
		}

		return {
			sourceName: filename || '',
			mark: headerResult.header.item || filename || '',
			header: headerResult.header,
			contours: contourResult.contours,
			warnings: warnings
		};
	}

	// Reverse the contour and drop the duplicated closing vertex, matching the
	// reference writer. The radius on a vertex describes the arc starting there,
	// so after reversal the radius that applies to a written segment is the one
	// on its end vertex.
	function contourToPolyline(contour) {
		var cleaned = dropClosingPoint(contour.points);
		var reversed = [];
		for (var i = cleaned.length - 1; i >= 0; i--) {
			reversed.push(cleaned[i]);
		}
		return reversed;
	}

	function segmentBulge(current, following) {
		var radius = following.radius || 0;
		if (!radius) {
			return 0;
		}
		var dx = following.x - current.x;
		var dy = following.y - current.y;
		var chord = Math.sqrt(dx * dx + dy * dy);
		if (chord <= 1e-10) {
			return 0;
		}
		var diameter = 2 * Math.abs(radius);
		var sign = radius < 0 ? 1 : -1;

		if (Math.abs(chord - diameter) <= ARC_TOLERANCE_MM) {
			return sign;
		}
		if (chord > diameter) {
			return 0;
		}

		var ratio = Math.min(1, Math.max(0, chord / diameter));
		var angle = 2 * Math.atan2(ratio, Math.sqrt(Math.max(0, 1 - ratio * ratio)));
		return sign * Math.tan(angle / 4);
	}

	/*
	 * Sample the circular arc described by a DXF-style bulge.
	 * Returns the points after `current`, ending exactly on `next`.
	 */
	function arcPoints(current, next, bulge, tolerance) {
		if (!bulge) {
			return [next];
		}

		var dx = next.x - current.x;
		var dy = next.y - current.y;
		var chord = Math.sqrt(dx * dx + dy * dy);
		if (chord <= 1e-10) {
			return [next];
		}

		var theta = 4 * Math.atan(bulge);
		var absTheta = Math.abs(theta);
		if (absTheta <= 1e-9) {
			return [next];
		}

		var radius = chord / (2 * Math.sin(absTheta / 2));
		if (!isFinite(radius) || radius <= 0) {
			return [next];
		}

		// Signed distance from chord midpoint to circle centre along the left
		// normal. Positive bulge puts the centre on the left of the chord.
		var h = (chord / 2) * (1 - bulge * bulge) / (2 * bulge);
		var mx = (current.x + next.x) / 2;
		var my = (current.y + next.y) / 2;
		var cx = mx + h * (-dy / chord);
		var cy = my + h * (dx / chord);

		var startAngle = Math.atan2(current.y - cy, current.x - cx);
		var step = 2 * Math.acos(Math.min(1, Math.max(-1, 1 - (tolerance || 0.1) / radius)));
		if (!isFinite(step) || step <= 1e-6) {
			step = PI / 32;
		}
		var count = Math.max(1, Math.ceil(absTheta / step));
		if (count > 256) {
			count = 256;
		}

		var result = [];
		for (var i = 1; i < count; i++) {
			var angle = startAngle + theta * (i / count);
			result.push({
				x: cx + radius * Math.cos(angle),
				y: cy + radius * Math.sin(angle),
				radius: 0
			});
		}
		result.push({ x: next.x, y: next.y, radius: 0 });
		return result;
	}

	function contourToSampledPoints(contour, tolerance) {
		var vertices = contourToPolyline(contour);
		if (vertices.length < 2) {
			return [];
		}

		var points = [vertices[0]];
		for (var i = 0; i < vertices.length; i++) {
			var current = vertices[i];
			var next = vertices[(i + 1) % vertices.length];
			var bulge = segmentBulge(current, next);
			if (!bulge) {
				points.push({ x: next.x, y: next.y });
				continue;
			}
			var sampled = arcPoints(current, next, bulge, tolerance);
			for (var j = 0; j < sampled.length; j++) {
				points.push({ x: sampled[j].x, y: sampled[j].y });
			}
		}

		// The closing segment ends on the first point; drop the duplicate and
		// let the path's Z command close it.
		if (points.length > 1 && sameXY(points[0], points[points.length - 1])) {
			points.pop();
		}
		return points;
	}

	function pointBounds(contours) {
		var minX = null;
		var minY = null;
		var maxX = null;
		var maxY = null;
		for (var i = 0; i < contours.length; i++) {
			for (var j = 0; j < contours[i].length; j++) {
				var point = contours[i][j];
				if (minX === null || point.x < minX) { minX = point.x; }
				if (minY === null || point.y < minY) { minY = point.y; }
				if (maxX === null || point.x > maxX) { maxX = point.x; }
				if (maxY === null || point.y > maxY) { maxY = point.y; }
			}
		}
		if (minX === null) {
			return null;
		}
		return { x: minX, y: minY, maxX: maxX, maxY: maxY, width: maxX - minX, height: maxY - minY };
	}

	function formatNumber(value) {
		// Keep the SVG compact but avoid scientific notation surprises.
		var rounded = Math.round(value * 1e6) / 1e6;
		return String(rounded);
	}

	function nc1ToSvg(part, options) {
		options = options || {};
		var tolerance = options.curveTolerance;
		if (!(tolerance > 0)) {
			tolerance = 0.1;
		}

		var rendered = [];
		for (var c = 0; c < part.contours.length; c++) {
			var points = contourToSampledPoints(part.contours[c], tolerance);
			if (points.length >= 2) {
				rendered.push(points);
			}
		}

		var bounds = pointBounds(rendered);
		if (!bounds) {
			throw new Nc1Error('NC1 part has no points to render.');
		}

		var width = bounds.width > 0 ? bounds.width : 1;
		var height = bounds.height > 0 ? bounds.height : 1;

		// NC1 is Y-up; SVG is Y-down. Translate to a positive viewBox while
		// flipping Y.
		function tx(point) {
			return point.x - bounds.x;
		}
		function ty(point) {
			return bounds.maxY - point.y;
		}

		var paths = [];
		for (var r = 0; r < rendered.length; r++) {
			var contourPoints = rendered[r];
			var d = 'M ' + formatNumber(tx(contourPoints[0])) + ' ' + formatNumber(ty(contourPoints[0]));
			for (var i = 1; i < contourPoints.length; i++) {
				d += ' L ' + formatNumber(tx(contourPoints[i])) + ' ' + formatNumber(ty(contourPoints[i]));
			}
			d += ' Z';
			paths.push('<path d="' + d + '" fill="none" stroke="#000000" stroke-width="0.1" />');
		}

		if (paths.length === 0) {
			throw new Nc1Error('NC1 part has no usable contours to render.');
		}

		var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + formatNumber(width) +
			'mm" height="' + formatNumber(height) + 'mm" viewBox="0 0 ' +
			formatNumber(width) + ' ' + formatNumber(height) + '">' +
			paths.join('') + '</svg>';

		return {
			svg: svg,
			width: width,
			height: height,
			bounds: bounds,
			contourCount: paths.length
		};
	}

	return {
		Nc1Error: Nc1Error,
		parseNc1: parseNc1,
		nc1ToSvg: nc1ToSvg,
		contourToPolyline: contourToPolyline,
		segmentBulge: segmentBulge,
		arcPoints: arcPoints,
		numbers: numbers,
		decodeLatin1: decodeLatin1
	};
});
