/*
 * DxfLabels
 * The server-side SVG -> DXF converter writes SVG text as several TEXT
 * entities (Inkscape splits glyph runs). Operators want one TEXT entity per
 * part mark, so this module merges the fragments that make up each known mark.
 *
 * Geometry and every other DXF entity are left untouched.
 *
 * Works as a plain browser script (window.DxfLabels) and as a Node module.
 */
(function (root, factory) {
	var api = factory();
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
	if (root) {
		root.DxfLabels = api;
	}
})(typeof self !== 'undefined' ? self : (typeof global !== 'undefined' ? global : this), function () {
	'use strict';

	function firstCode(block, code) {
		var values = block.codes[code];
		return values && values.length > 0 ? values[0] : '';
	}

	function numberOr(value, fallback) {
		var number = parseFloat(value);
		return isFinite(number) ? number : fallback;
	}

	function cleanText(value) {
		return String(value == null ? '' : value)
			.replace(/\\P/gi, ' ')
			.replace(/[{}]/g, '')
			.replace(/\s+/g, ' ')
			.trim();
	}

	function normalize(value) {
		return cleanText(value).replace(/\s+/g, '').toUpperCase();
	}

	/*
	 * Split the file into code-0 entity blocks while keeping the exact line
	 * range of each one, so untouched entities can be copied byte for byte.
	 */
	function parseBlocks(lines) {
		var blocks = [];
		var i = 0;

		while (i + 1 < lines.length) {
			var code = parseInt(lines[i].trim(), 10);
			if (!isFinite(code)) {
				i++;
				continue;
			}
			if (code !== 0) {
				i += 2;
				continue;
			}

			var block = {
				start: i,
				type: String(lines[i + 1] || '').trim().toUpperCase(),
				codes: {},
				end: lines.length
			};

			var j = i + 2;
			while (j + 1 < lines.length) {
				var nextCode = parseInt(lines[j].trim(), 10);
				if (!isFinite(nextCode)) {
					j++;
					continue;
				}
				if (nextCode === 0) {
					break;
				}
				if (!block.codes[nextCode]) {
					block.codes[nextCode] = [];
				}
				block.codes[nextCode].push(lines[j + 1]);
				j += 2;
			}

			block.end = j;
			blocks.push(block);
			i = j;
		}

		return blocks;
	}

	function textValue(block) {
		var chunks = (block.codes[3] || []).map(cleanText);
		var final = cleanText(firstCode(block, 1));
		return cleanText(chunks.join('') + final);
	}

	function collectTexts(blocks) {
		var texts = [];
		for (var i = 0; i < blocks.length; i++) {
			var block = blocks[i];
			if (block.type !== 'TEXT' && block.type !== 'MTEXT') {
				continue;
			}
			var value = textValue(block);
			if (!value) {
				continue;
			}
			texts.push({
				block: block,
				blockIndex: i,
				value: value,
				norm: normalize(value),
				layer: cleanText(firstCode(block, 8)) || '0',
				color: firstCode(block, 62),
				style: firstCode(block, 7),
				rotation: firstCode(block, 50),
				x: numberOr(firstCode(block, 10), null),
				y: numberOr(firstCode(block, 20), null),
				height: numberOr(firstCode(block, 40), 10)
			});
		}
		return texts;
	}

	function normalizeMarks(marks) {
		var result = [];
		for (var i = 0; i < marks.length; i++) {
			var mark = marks[i];
			if (mark && typeof mark === 'object') {
				mark = mark.mark || mark.name || '';
			}
			mark = String(mark == null ? '' : mark).trim();
			if (!mark) {
				continue;
			}
			result.push({ mark: mark, norm: normalize(mark) });
		}
		return result;
	}

	function findMatches(texts, marks) {
		var used = {};
		var matches = [];
		var warnings = [];

		// Longest first at each start position prevents a shorter mark that is a
		// prefix of another mark from winning.
		var unique = {};
		for (var m = 0; m < marks.length; m++) {
			if (!unique[marks[m].norm]) {
				unique[marks[m].norm] = marks[m].mark;
			}
		}
		var candidates = Object.keys(unique).map(function (norm) {
			return { norm: norm, mark: unique[norm] };
		}).sort(function (a, b) {
			return b.norm.length - a.norm.length;
		});

		for (var i = 0; i < texts.length; i++) {
			if (used[i]) {
				continue;
			}

			var found = null;
			for (var c = 0; c < candidates.length; c++) {
				var candidate = candidates[c];
				var concat = '';
				var indexes = [];

				for (var j = i; j < texts.length; j++) {
					if (used[j]) {
						continue;
					}
					if (!texts[j].norm) {
						continue;
					}
					concat += texts[j].norm;
					indexes.push(j);

					if (concat === candidate.norm) {
						found = {
							mark: candidate.mark,
							first: i,
							last: j,
							indexes: indexes
						};
						break;
					}
					if (concat.length >= candidate.norm.length) {
						break;
					}
				}
				if (found) {
					break;
				}
			}

			if (!found) {
				continue;
			}

			for (var k = 0; k < found.indexes.length; k++) {
				used[found.indexes[k]] = true;
			}
			matches.push(found);
		}

		// Every expected mark occurrence should have produced one match. Build a
		// compact count map so duplicate marks are handled naturally.
		var expected = {};
		for (m = 0; m < marks.length; m++) {
			expected[marks[m].norm] = (expected[marks[m].norm] || 0) + 1;
		}
		for (m = 0; m < matches.length; m++) {
			var key = normalize(matches[m].mark);
			expected[key] = (expected[key] || 0) - 1;
		}
		for (var missing in expected) {
			if (Object.prototype.hasOwnProperty.call(expected, missing) && expected[missing] > 0) {
				warnings.push({
					code: 'DXF_LABEL_NOT_FOUND',
					message: 'Could not merge ' + expected[missing] +
						' label(s) for mark ' + missing + '; converter text was left as-is.',
					severity: 'warning'
				});
			}
		}

		return { matches: matches, warnings: warnings };
	}

	function buildReplacement(match, texts, options) {
		options = options || {};
		var first = texts[match.first];
		var last = texts[match.last];
		var minX = first.x;
		var maxX = last.x;

		if (minX == null) {
			minX = 0;
		}
		if (maxX == null) {
			maxX = minX + first.height * 0.6 * first.value.length;
		} else {
			maxX += last.height * 0.6 * last.value.length;
		}

		var centerX = (minX + maxX) / 2;
		var y = first.y == null ? 0 : first.y;
		var height = first.height || 10;

		var layer = options.labelLayer || 'TEXT';
		var color = options.labelColor == null ? '2' : String(options.labelColor);
		var lines = [
			'0', 'TEXT',
			'8', layer
		];
		if (color !== '') {
			lines.push('62', color);
		}
		lines.push('10', String(centerX));
		lines.push('20', String(y));
		lines.push('30', '0');
		lines.push('40', String(height));
		lines.push('1', match.mark);
		if (first.style) {
			lines.push('7', first.style);
		}
		if (first.rotation) {
			lines.push('50', first.rotation);
		}
		lines.push('72', '1');
		lines.push('73', '2');
		lines.push('11', String(centerX));
		lines.push('21', String(y));
		lines.push('31', '0');

		return lines;
	}

	function rewriteDxfLabels(text, marks, options) {
		options = options || {};
		var source = String(text == null ? '' : text);
		var eol = /\r\n/.test(source) ? '\r\n' : '\n';
		var lines = source.split(/\r\n|\r|\n/);
		var markList = normalizeMarks(marks || []);
		var warnings = [];

		if (!source.trim()) {
			return { text: source, merged: 0, warnings: warnings };
		}
		if (markList.length === 0) {
			return { text: source, merged: 0, warnings: warnings };
		}

		var blocks = parseBlocks(lines);
		var texts = collectTexts(blocks);
		if (texts.length === 0) {
			warnings.push({
				code: 'DXF_NO_TEXT',
				message: 'The converted DXF has no TEXT entities; part marks cannot be merged.',
				severity: 'warning'
			});
			return { text: source, merged: 0, warnings: warnings };
		}

		var found = findMatches(texts, markList);
		warnings = warnings.concat(found.warnings);

		var replaceByBlock = {};
		var removeByBlock = {};
		for (var i = 0; i < found.matches.length; i++) {
			var match = found.matches[i];
			var firstBlockIndex = texts[match.first].blockIndex;
			replaceByBlock[firstBlockIndex] = buildReplacement(match, texts, options);
			for (var j = match.first + 1; j <= match.last; j++) {
				removeByBlock[texts[j].blockIndex] = true;
			}
		}

		var output = [];
		var cursor = 0;
		for (var b = 0; b < blocks.length; b++) {
			var block = blocks[b];
			for (; cursor < block.start; cursor++) {
				output.push(lines[cursor]);
			}
			if (removeByBlock[b]) {
				// drop the fragment
			} else if (replaceByBlock[b]) {
				output = output.concat(replaceByBlock[b]);
			} else {
				for (var l = block.start; l < block.end; l++) {
					output.push(lines[l]);
				}
			}
			cursor = block.end;
		}
		for (; cursor < lines.length; cursor++) {
			output.push(lines[cursor]);
		}

		return {
			text: output.join(eol),
			merged: found.matches.length,
			warnings: warnings
		};
	}

	return {
		rewriteDxfLabels: rewriteDxfLabels,
		parseBlocks: parseBlocks,
		normalize: normalize
	};
});
