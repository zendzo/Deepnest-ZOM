/*
 * DxfMeta
 * Reads the metadata block the Tekla/AutoNest DXF writers put on the TEXT
 * layer. Only the group-code structure is parsed here; geometry is left to the
 * existing SVG conversion path.
 *
 * Works as a plain browser script (window.DxfMeta) and as a Node module.
 */
(function (root, factory) {
	var api = factory();
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
	if (root) {
		root.DxfMeta = api;
	}
})(typeof self !== 'undefined' ? self : (typeof global !== 'undefined' ? global : this), function () {
	'use strict';

	var TAG_RE = /\[([A-Za-z0-9]+)\]([^\[]*)/g;
	var INTEGER_RE = /-?\d+/;
	var FLOAT_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;

	function splitLines(text) {
		return String(text == null ? '' : text).split(/\r\n|\r|\n/);
	}

	/*
	 * Convert the flat code/value lines into entity objects.
	 * DXF is line oriented: a numeric group code line is followed by one value
	 * line. Pairing sequentially (instead of regex-scanning) is important
	 * because values themselves are often numeric.
	 */
	function parseEntities(text) {
		var lines = splitLines(text);
		var entities = [];
		var current = null;
		var i;

		function flush() {
			if (current) {
				entities.push(current);
				current = null;
			}
		}

		for (i = 0; i + 1 < lines.length;) {
			var codeText = lines[i].trim();
			if (!/^-?\d+$/.test(codeText)) {
				i++;
				continue;
			}

			var code = parseInt(codeText, 10);
			var value = lines[i + 1];
			i += 2;

			if (code === 0) {
				flush();
				current = {
					type: String(value || '').trim().toUpperCase(),
					codes: {}
				};
				continue;
			}

			if (current) {
				if (!current.codes[code]) {
					current.codes[code] = [];
				}
				current.codes[code].push(value);
			}
		}

		flush();
		return entities;
	}

	function firstCode(entity, code) {
		var values = entity.codes[code];
		return values && values.length > 0 ? values[0] : '';
	}

	function allCodes(entity, code) {
		return entity.codes[code] || [];
	}

	function cleanText(value) {
		return String(value == null ? '' : value)
			.replace(/\\P/gi, ' ')
			.replace(/\\~/g, ' ')
			.replace(/[{}]/g, '')
			.replace(/\s+/g, ' ')
			.trim();
	}

	function extractTags(value) {
		var tags = {};
		var match;
		TAG_RE.lastIndex = 0;
		while ((match = TAG_RE.exec(value)) !== null) {
			var key = match[1].toUpperCase();
			var tagValue = cleanText(match[2]);
			if (tagValue && !tags[key]) {
				tags[key] = tagValue;
			}
		}
		return tags;
	}

	function parseQuantity(value) {
		var match = INTEGER_RE.exec(String(value || ''));
		if (!match) {
			return { quantity: 1, valid: false };
		}
		var quantity = parseInt(match[0], 10);
		if (!isFinite(quantity) || quantity < 1) {
			return { quantity: 1, valid: false };
		}
		return { quantity: quantity, valid: true };
	}

	function parseNumber(value) {
		var match = FLOAT_RE.exec(String(value || ''));
		if (!match) {
			return null;
		}
		var number = parseFloat(match[0]);
		return isFinite(number) ? number : null;
	}

	function readTextEntity(entity) {
		var type = entity.type;
		var chunks = allCodes(entity, 3).map(cleanText);
		var final = cleanText(firstCode(entity, 1));
		var value = cleanText(chunks.join('') + final);

		if (!value) {
			return null;
		}

		return {
			type: type,
			layer: cleanText(firstCode(entity, 8)),
			color: parseNumber(firstCode(entity, 62)),
			x: parseNumber(firstCode(entity, 10)),
			y: parseNumber(firstCode(entity, 20)),
			height: parseNumber(firstCode(entity, 40)),
			value: value,
			tags: extractTags(value)
		};
	}

	function parseDxfMeta(text) {
		var entities = parseEntities(text);
		var texts = [];
		var i;

		for (i = 0; i < entities.length; i++) {
			if (entities[i].type !== 'TEXT' && entities[i].type !== 'MTEXT') {
				continue;
			}
			var parsed = readTextEntity(entities[i]);
			if (parsed) {
				texts.push(parsed);
			}
		}

		var tags = {};
		var bareMark = null;
		for (i = 0; i < texts.length; i++) {
			var item = texts[i];
			for (var key in item.tags) {
				if (Object.prototype.hasOwnProperty.call(item.tags, key) && !tags[key]) {
					tags[key] = item.tags[key];
				}
			}
			// The LISP writes the part mark as centred colour-2 text on TEXT.
			if (!bareMark && item.layer.toUpperCase() === 'TEXT' && item.color === 2) {
				bareMark = item.value;
			}
		}

		var mark = tags.N || tags.P || tags.I || bareMark || null;
		var markSource = tags.N ? 'N' : (tags.P ? 'P' : (tags.I ? 'I' : (bareMark ? 'color2' : null)));
		var quantityResult = parseQuantity(tags.Q);
		var warnings = [];

		if (!mark) {
			warnings.push({
				code: 'DXF_NO_PART_MARK',
				message: 'No [N], [P] or [I] part mark found; the filename will be used.',
				severity: 'warning'
			});
		}
		if (!quantityResult.valid) {
			warnings.push({
				code: 'DXF_QUANTITY_INVALID',
				message: 'DXF quantity is missing or invalid; quantity 1 will be used.',
				severity: 'warning'
			});
		}

		return {
			mark: mark,
			markSource: markSource,
			item: tags.I || tags.N || tags.P || mark,
			quantity: quantityResult.quantity,
			material: tags.M || '',
			thickness: parseNumber(tags.T),
			section: tags.S || '',
			project: tags.B || '',
			tags: tags,
			texts: texts,
			warnings: warnings
		};
	}

	return {
		parseEntities: parseEntities,
		parseDxfMeta: parseDxfMeta,
		extractTags: extractTags
	};
});
