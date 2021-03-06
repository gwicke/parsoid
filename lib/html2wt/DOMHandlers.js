'use strict';
require('../../core-upgrade.js');

var Promise = require('prfun');

var JSUtils = require('../utils/jsutils.js').JSUtils;
var Util = require('../utils/Util.js').Util;
var DU = require('../utils/DOMUtils.js').DOMUtils;
var WTSUtils = require('./WTSUtils.js').WTSUtils;
var Consts = require('../config/WikitextConstants.js').WikitextConstants;

/**
 * Definitions of what's loosely defined as the `domHandler` interface.
 *
 * FIXME: Solidify the interface in code.
 *
 *   var domHandler = {
 *     handle: Promise.method(function(node, state, wrapperUnmodified) { ... }),
 *     sepnls: {
 *       before: (node, otherNode, state) => { min: 1, max: 2 },
 *       after: (node, otherNode, state) => { ... },
 *       firstChild: (node, otherNode, state) => { ... },
 *       lastChild: (node, otherNode, state) => { ... },
 *     },
 *   };
 */

// Forward declaration
var _htmlElementHandler;

function id(v) {
	return function() { return v; };
}

var genContentSpanTypes = new Set([
	'mw:Nowiki',
	'mw:Image',
	'mw:Image/Frameless',
	'mw:Image/Frame',
	'mw:Image/Thumb',
	'mw:Entity',
	'mw:DiffMarker',
	'mw:Placeholder',
]);

function isRecognizedSpanWrapper(type) {
	return type && type.split(/\s+/).find(function(t) {
		return genContentSpanTypes.has(t);
	}) !== undefined;
}

function buildHeadingHandler(headingWT) {
	return {
		forceSOL: true,
		handle: Promise.method(function(node, state, wrapperUnmodified) {
			// For new elements, for prettier wikitext serialization,
			// emit a space after the last '=' char.
			var space = '';
			if (DU.isNewElt(node)) {
				var fc = node.firstChild;
				if (fc && (!DU.isText(fc) || !fc.nodeValue.match(/^\s/))) {
					space = ' ';
				}
			}
			state.emitChunk(headingWT + space, node);
			state.singleLineContext.enforce();

			var p;
			if (node.childNodes.length) {
				var headingHandler = state.serializer.wteHandlers.headingHandler
						.bind(state.serializer.wteHandlers, node);
				p = state.serializeChildren(node, headingHandler);
			} else {
				// Deal with empty headings
				state.emitChunk('<nowiki/>', node);
				p = Promise.resolve();
			}
			return p.then(function() {
				// For new elements, for prettier wikitext serialization,
				// emit a space before the first '=' char.
				space = '';
				if (DU.isNewElt(node)) {
					var lc = node.lastChild;
					if (lc && (!DU.isText(lc) || !lc.nodeValue.match(/\s$/))) {
						space = ' ';
					}
				}
				state.emitChunk(space + headingWT, node);
				state.singleLineContext.pop();
			});
		}),
		sepnls: {
			before: function(node, otherNode) {
				if (DU.isNewElt(node) && DU.previousNonSepSibling(node)) {
					// Default to two preceding newlines for new content
					return { min: 2, max: 2 };
				} else if (DU.isNewElt(otherNode) &&
					DU.previousNonSepSibling(node) === otherNode) {
					// T72791: The previous node was newly inserted, separate
					// them for readability
					return { min: 2, max: 2 };
				} else {
					return { min: 1, max: 2 };
				}
			},
			after: id({ min: 1, max: 2 }),
		},
	};
}

/**
 * List helper: DOM-based list bullet construction
 */
function getListBullets(state, node) {
	var parentTypes = {
		ul: '*',
		ol: '#',
	};
	var listTypes = {
		ul: '',
		ol: '',
		dl: '',
		li: '',
		dt: ';',
		dd: ':',
	};

	// For new elements, for prettier wikitext serialization,
	// emit a space after the last bullet (if required)
	var space = '';
	if (DU.isNewElt(node)) {
		var fc = node.firstChild;
		if (fc && (!DU.isText(fc) || !fc.nodeValue.match(/^\s/))) {
			space = ' ';
		}
	}

	var dp, nodeName, parentName;
	var res = '';
	while (node) {
		nodeName = node.nodeName.toLowerCase();
		dp = DU.getDataParsoid(node);

		if (dp.stx !== 'html' && nodeName in listTypes) {
			if (nodeName === 'li') {
				var parentNode = node.parentNode;
				while (parentNode && !(parentNode.nodeName.toLowerCase() in parentTypes)) {
					parentNode = parentNode.parentNode;
				}

				if (parentNode) {
					parentName = parentNode.nodeName.toLowerCase();
					res = parentTypes[parentName] + res;
				} else {
					state.env.log("error/html2wt", "Input DOM is not well-formed.",
						"Top-level <li> found that is not nested in <ol>/<ul>\n LI-node:",
						node.outerHTML);
				}
			} else {
				res = listTypes[nodeName] + res;
			}
		} else if (dp.stx !== 'html' || !dp.autoInsertedStart || !dp.autoInsertedEnd) {
			break;
		}

		node = node.parentNode;
	}

	return res + space;
}

function wtListEOL(node, otherNode) {
	if (!DU.isElt(otherNode) || DU.isBody(otherNode) ||
		DU.isFirstEncapsulationWrapperNode(otherNode)) {
		return { min: 0, max: 2 };
	}

	var nextSibling = DU.nextNonSepSibling(node);
	var dp = DU.getDataParsoid(otherNode);
	if (nextSibling === otherNode && dp.stx === 'html' || dp.src) {
		return { min: 0, max: 2 };
	} else if (nextSibling === otherNode && DU.isListOrListItem(otherNode)) {
		if (DU.isList(node) && otherNode.nodeName === node.nodeName) {
			// Adjacent lists of same type need extra newline
			return { min: 2, max: 2 };
		} else if (DU.isListItem(node) || node.parentNode.nodeName in { LI: 1, DD: 1 }) {
			// Top-level list
			return { min: 1, max: 1 };
		} else {
			return { min: 1, max: 2 };
		}
	} else if (DU.isList(otherNode) ||
			(DU.isElt(otherNode) && dp.stx === 'html')) {
		// last child in ul/ol (the list element is our parent), defer
		// separator constraints to the list.
		return {};
	} else {
		return { min: 1, max: 2 };
	}
}

// Normally we wait until hitting the deepest nested list element before
// emitting bullets. However, if one of those list elements is about-id
// marked, the tag handler will serialize content from data-mw parts or src.
// This is a problem when a list wasn't assigned the shared prefix of bullets.
// For example,
//
//   ** a
//   ** b
//
// Will assign bullets as,
//
// <ul><li-*>
//   <ul>
//     <li-*> a</li>   <!-- no shared prefix  -->
//     <li-**> b</li>  <!-- gets both bullets -->
//   </ul>
// </li></ul>
//
// For the b-li, getListsBullets will walk up and emit the two bullets it was
// assigned. If it was about-id marked, the parts would contain the two bullet
// start tag it was assigned. However, for the a-li, only one bullet is
// associated. When it's about-id marked, serializing the data-mw parts or
// src would miss the bullet assigned to the container li.
function isTplListWithoutSharedPrefix(node) {
	if (!DU.isTplOrExtToplevelNode(node)) {
		return false;
	}

	var typeOf = node.getAttribute("typeof") || '';

	if (/(?:^|\s)mw:Transclusion(?=$|\s)/.test(typeOf)) {
		// If the first part is a string, template ranges were expanded to
		// include this list element. That may be trouble. Otherwise,
		// containers aren't part of the template source and we should emit
		// them.
		var dataMw = DU.getDataMw(node);
		if (!dataMw.parts || typeof dataMw.parts[0] !== "string") {
			return true;
		}
		// Less than two bullets indicates that a shared prefix was not
		// assigned to this element. A safe indication that we should call
		// getListsBullets on the containing list element.
		return !/^[*#:;]{2,}$/.test(dataMw.parts[0]);
	} else if (/(?:^|\s)mw:(Extension|Param)/.test(typeOf)) {
		// Containers won't ever be part of the src here, so emit them.
		return true;
	} else {
		return false;
	}
}

function buildListHandler(firstChildNames) {
	function isBuilderInsertedElt(node) {
		var dp = DU.getDataParsoid(node);
		return dp && dp.autoInsertedStart && dp.autoInsertedEnd;
	}

	return {
		forceSOL: true,
		handle: Promise.method(function(node, state, wrapperUnmodified) {
			// Disable single-line context here so that separators aren't
			// suppressed between nested list elements.
			state.singleLineContext.disable();
			var firstChildElt = DU.firstNonSepChildNode(node);

			// Skip builder-inserted wrappers
			// Ex: <ul><s auto-inserted-start-and-end-><li>..</li><li>..</li></s>...</ul>
			// output from: <s>\n*a\n*b\n*c</s>
			while (firstChildElt && isBuilderInsertedElt(firstChildElt)) {
				firstChildElt = DU.firstNonSepChildNode(firstChildElt);
			}

			if (!firstChildElt || !(firstChildElt.nodeName in firstChildNames) || isTplListWithoutSharedPrefix(firstChildElt)) {
				state.emitChunk(getListBullets(state, node), node);
			}

			var liHandler = state.serializer.wteHandlers.liHandler
					.bind(state.serializer.wteHandlers, node);
			return state.serializeChildren(node, liHandler).then(function() {
				state.singleLineContext.pop();
			});
		}),
		sepnls: {
			before: function(node, otherNode) {
				// SSS FIXME: Thoughts about a fix (abandoned in this patch)
				//
				// Checking for DU.isBody(otherNode) and returning
				// {min:0, max:0} should eliminate the annoying leading newline
				// bug in parser tests, but it seems to cause other niggling issues
				// <ul> <li>foo</li></ul> serializes to " *foo" which is buggy.
				// So, we may need another constraint/flag/test in makeSeparator
				// about the node and its context so that leading pre-inducing WS
				// can be stripped

				if (DU.isBody(otherNode)) {
					return { min: 0, max: 0 };
				} else if (DU.isText(otherNode) && DU.isListItem(node.parentNode)) {
					// A list nested inside a list item
					// <li> foo <dl> .. </dl></li>
					return { min: 1, max: 1 };
				} else {
					return { min: 1, max: 2 };
				}
			},
			after: wtListEOL,
		},
	};
}

function buildDDHandler(stx) {
	return {
		forceSOL: stx !== 'row',
		handle: Promise.method(function(node, state, wrapperUnmodified) {
			var firstChildElement = DU.firstNonSepChildNode(node);
			if (!DU.isList(firstChildElement) || isTplListWithoutSharedPrefix(firstChildElement)) {
				if (stx === 'row') {
					state.emitChunk(':', node);
				} else {
					state.emitChunk(getListBullets(state, node), node);
				}
			}
			var liHandler = state.serializer.wteHandlers.liHandler
					.bind(state.serializer.wteHandlers, node);
			state.singleLineContext.enforce();
			return state.serializeChildren(node, liHandler).then(function() {
				state.singleLineContext.pop();
			});
		}),
		sepnls: {
			before: function(node, othernode) {
				if (stx === 'row') {
					return { min: 0, max: 0 };
				} else {
					return { min: 1, max: 2 };
				}
			},
			after: wtListEOL,
			firstChild: function(node, otherNode) {
				if (!DU.isList(otherNode)) {
					return { min: 0, max: 0 };
				} else {
					return {};
				}
			},
		},
	};
}

// IMPORTANT: Do not start walking from line.firstNode forward. Always
// walk backward from node. This is because in selser mode, it looks like
// line.firstNode doesn't always correspond to the wikitext line that is
// being processed since the previous emitted node might have been an unmodified
// DOM node that generated multiple wikitext lines.
function currWikitextLineHasBlockNode(line, node, skipNode) {
	var parentNode = node.parentNode;
	if (!skipNode) {
		// If this node could break this wikitext line and emit
		// non-ws content on a new line, the P-tag will be on that new line
		// with text content that needs P-wrapping.
		if (/\n[^\s]/.test(node.textContent)) {
			return false;
		}
	}
	node = DU.previousNonDeletedSibling(node);
	while (!node || !DU.atTheTop(node)) {
		while (node) {
			// If we hit a block node that will render on the same line, we are done!
			if (DU.isBlockNodeWithVisibleWT(node)) {
				return true;
			}

			// If this node could break this wikitext line, we are done.
			// This is conservative because textContent could be looking at descendents
			// of 'node' that may not have been serialized yet. But this is safe.
			if (/\n/.test(node.textContent)) {
				return false;
			}

			node = DU.previousNonDeletedSibling(node);

			// Don't go past the current line in any case.
			if (line.firstNode && DU.isAncestorOf(node, line.firstNode)) {
				return false;
			}
		}
		node = parentNode;
		parentNode = node.parentNode;
	}

	return false;
}

function newWikitextLineMightHaveBlockNode(node) {
	node = DU.nextNonDeletedSibling(node);
	while (node) {
		if (DU.isText(node)) {
			// If this node will break this wikitext line, we are done!
			if (node.nodeValue.match(/\n/)) {
				return false;
			}
		} else if (DU.isElt(node)) {
			// These tags will always serialize onto a new line
			if (Consts.HTMLTagsRequiringSOLContext.has(node.nodeName) &&
					!DU.isLiteralHTMLNode(node)) {
				return false;
			}

			// We hit a block node that will render on the same line
			if (DU.isBlockNodeWithVisibleWT(node)) {
				return true;
			}

			// Go conservative
			return false;
		}

		node = DU.nextNonDeletedSibling(node);
	}
	return false;
}

function precedingQuoteEltRequiresEscape(node) {
	// * <i> and <b> siblings don't need a <nowiki/> separation
	//   as long as quote chars in text nodes are always
	//   properly escaped -- which they are right now.
	//
	// * Adjacent quote siblings need a <nowiki/> separation
	//   between them if either of them will individually
	//   generate a sequence of quotes 4 or longer. That can
	//   only happen when either prev or node is of the form:
	//   <i><b>...</b></i>
	//
	//   For new/edited DOMs, this can never happen because
	//   wts.minimizeQuoteTags.js does quote tag minimization.
	//
	//   For DOMs from existing wikitext, this can only happen
	//   because of auto-inserted end/start tags. (Ex: ''a''' b ''c''')
	var prev = DU.previousNonDeletedSibling(node);
	return prev && DU.isQuoteElt(prev) && (
		DU.isQuoteElt(DU.lastNonDeletedChildNode(prev)) ||
		DU.isQuoteElt(DU.firstNonDeletedChildNode(node)));
}

function buildQuoteHandler(quotes) {
	return {
		handle: Promise.method(function(node, state, wrapperUnmodified) {
			if (precedingQuoteEltRequiresEscape(node)) {
				WTSUtils.emitStartTag('<nowiki/>', node, state);
			}
			WTSUtils.emitStartTag(quotes, node, state);

			if (node.childNodes.length === 0) {
				// Empty nodes like <i></i> or <b></b> need
				// a <nowiki/> in place of the empty content so that
				// they parse back identically.
				if (WTSUtils.emitEndTag(quotes, node, state, true)) {
					WTSUtils.emitStartTag('<nowiki/>', node, state);
					WTSUtils.emitEndTag(quotes, node, state);
				}
				return;
			} else {
				return state.serializeChildren(node).then(function() {
					WTSUtils.emitEndTag(quotes, node, state);
				});
			}
		}),
	};
}

var serializeTableElement = Promise.method(function(symbol, endSymbol, state, node) {
	var token = DU.mkTagTk(node);
	return state.serializer._serializeAttributes(node, token)
			.then(function(sAttribs) {
		if (sAttribs.length > 0) {
			// IMPORTANT: 'endSymbol !== null' NOT 'endSymbol' since the
			// '' string is a falsy value and we want to treat it as a
			// truthy value.
			return symbol + ' ' + sAttribs +
				(endSymbol !== null ? endSymbol : ' |');
		} else {
			return symbol + (endSymbol || '');
		}
	});
});

var serializeTableTag = Promise.method(function(symbol, endSymbol, state,
		node, wrapperUnmodified) {
	if (wrapperUnmodified) {
		var dsr = DU.getDataParsoid(node).dsr;
		return state.getOrigSrc(dsr[0], dsr[0] + dsr[2]);
	} else {
		return serializeTableElement(symbol, endSymbol, state, node);
	}
});

// Just serialize the children, ignore the (implicit) tag
var justChildren = {
	handle: Promise.method(function(node, state, wrapperUnmodified) {
		return state.serializeChildren(node);
	}),
};

function stxInfoValidForTableCell(state, node) {
	// If there is no syntax info, nothing to worry about
	if (!DU.getDataParsoid(node).stx_v) {
		return true;
	}

	// If we have an identical previous sibling, nothing to worry about
	var prev = DU.previousNonDeletedSibling(node);
	return prev !== null && prev.nodeName === node.nodeName;
}

/**
 * A map of `domHandler`s keyed on nodeNames.
 *
 * Includes specialized keys of the form: nodeName + '_' + dp.stx
 */
var tagHandlers = JSUtils.mapObject({
	b: buildQuoteHandler("'''"),
	i: buildQuoteHandler("''"),

	dl: buildListHandler({ DT: 1, DD: 1 }),
	ul: buildListHandler({ LI: 1 }),
	ol: buildListHandler({ LI: 1 }),

	li: {
		forceSOL: true,
		handle: Promise.method(function(node, state, wrapperUnmodified) {
			var firstChildElement = DU.firstNonSepChildNode(node);
			if (!DU.isList(firstChildElement) ||
					isTplListWithoutSharedPrefix(firstChildElement)) {
				state.emitChunk(getListBullets(state, node), node);
			}
			var liHandler = state.serializer.wteHandlers.liHandler
					.bind(state.serializer.wteHandlers, node);
			state.singleLineContext.enforce();
			return state.serializeChildren(node, liHandler).then(function() {
				state.singleLineContext.pop();
			});
		}),
		sepnls: {
			before: function(node, otherNode) {
				if ((otherNode === node.parentNode && otherNode.nodeName in {UL: 1, OL: 1}) ||
					(DU.isElt(otherNode) && DU.getDataParsoid(otherNode).stx === 'html')) {
					return {};
				} else {
					return { min: 1, max: 2 };
				}
			},
			after: wtListEOL,
			firstChild: function(node, otherNode) {
				if (!DU.isList(otherNode)) {
					return { min: 0, max: 0 };
				} else {
					return {};
				}
			},
		},
	},

	dt: {
		forceSOL: true,
		handle: Promise.method(function(node, state, wrapperUnmodified) {
			var firstChildElement = DU.firstNonSepChildNode(node);
			if (!DU.isList(firstChildElement) ||
					isTplListWithoutSharedPrefix(firstChildElement)) {
				state.emitChunk(getListBullets(state, node), node);
			}
			var liHandler = state.serializer.wteHandlers.liHandler
					.bind(state.serializer.wteHandlers, node);
			state.singleLineContext.enforce();
			return state.serializeChildren(node, liHandler).then(function() {
				state.singleLineContext.pop();
			});
		}),
		sepnls: {
			before: id({ min: 1, max: 2 }),
			after: function(node, otherNode) {
				if (otherNode.nodeName === 'DD' &&
						DU.getDataParsoid(otherNode).stx === 'row') {
					return { min: 0, max: 0 };
				} else {
					return wtListEOL(node, otherNode);
				}
			},
			firstChild: function(node, otherNode) {
				if (!DU.isList(otherNode)) {
					return { min: 0, max: 0 };
				} else {
					return {};
				}
			},
		},
	},

	dd_row: buildDDHandler('row'), // single-line dt/dd
	dd: buildDDHandler(), // multi-line dt/dd

	// XXX: handle options
	table: {
		handle: Promise.method(function(node, state, wrapperUnmodified) {
			var dp = DU.getDataParsoid(node);
			var wt = dp.startTagSrc || "{|";
			var indentTable = node.parentNode.nodeName === 'DD' &&
					DU.previousNonSepSibling(node) === null;
			if (indentTable) {
				state.singleLineContext.disable();
			}
			return serializeTableTag(wt, '', state, node, wrapperUnmodified)
					.then(function(tableTag) {
				state.emitChunk(tableTag, node);
				if (!DU.isLiteralHTMLNode(node)) {
					state.wikiTableNesting++;
				}
				return state.serializeChildren(node);
			}).then(function() {
				if (!DU.isLiteralHTMLNode(node)) {
					state.wikiTableNesting--;
				}
				if (!state.sep.constraints) {
					// Special case hack for "{|\n|}" since state.sep is
					// cleared in SSP.pushSep after a separator is emitted.
					// However, for {|\n|}, the <table> tag has no element
					// children which means lastchild -> parent constraint
					// is never computed and set here.
					state.sep.constraints = { a: {}, b: {}, min: 1, max: 2 };
				}
				WTSUtils.emitEndTag(dp.endTagSrc || "|}", node, state);
				if (indentTable) {
					state.singleLineContext.pop();
				}
			});
		}),
		sepnls: {
			before: function(node, otherNode) {
				// Handle special table indentation case!
				if (node.parentNode === otherNode &&
						otherNode.nodeName === 'DD') {
					return { min: 0, max: 2 };
				} else {
					return { min: 1, max: 2 };
				}
			},
			after: function(node, otherNode) {
				if (DU.isNewElt(node) || DU.isNewElt(otherNode)) {
					return { min: 1, max: 2 };
				} else {
					return { min: 0, max: 2 };
				}
			},
			firstChild: id({ min: 1, max: 2 }),
			lastChild: id({ min: 1, max: 2 }),
		},
	},
	tbody: justChildren,
	thead: justChildren,
	tfoot: justChildren,
	tr: {
		handle: Promise.method(function(node, state, wrapperUnmodified) {
			// If the token has 'startTagSrc' set, it means that the tr
			// was present in the source wikitext and we emit it -- if not,
			// we ignore it.
			var dp = DU.getDataParsoid(node);
			// ignore comments and ws
			var p;
			if (DU.previousNonSepSibling(node) || dp.startTagSrc) {
				p = serializeTableTag(dp.startTagSrc || "|-", '', state, node,
						wrapperUnmodified).then(function(tableTag) {
					WTSUtils.emitStartTag(tableTag, node, state);
				});
			} else {
				p = Promise.resolve();
			}
			return p.then(function() {
				return state.serializeChildren(node);
			});
		}),
		sepnls: {
			before: function(node, othernode) {
				if (!DU.previousNonDeletedSibling(node) &&
						!DU.getDataParsoid(node).startTagSrc) {
					// first line
					return { min: 0, max: 2 };
				} else {
					return { min: 1, max: 2 };
				}
			},
			after: function(node, othernode) {
				return { min: 0, max: 2 };
			},
		},
	},
	th: {
		handle: Promise.method(function(node, state, wrapperUnmodified) {
			var dp = DU.getDataParsoid(node);
			var usableDP = stxInfoValidForTableCell(state, node);
			var startTagSrc = usableDP ? dp.startTagSrc : '';
			var attrSepSrc = usableDP ? dp.attrSepSrc : null;
			var src = (usableDP && dp.stx_v === 'row') ? '!!' : '!';

			// If the HTML for the first th is not enclosed in a tr-tag,
			// we start a new line.  If not, tr will have taken care of it.
			return serializeTableTag(startTagSrc || src, attrSepSrc || null,
					state, node, wrapperUnmodified).then(function(tableTag) {
				WTSUtils.emitStartTag(tableTag, node, state);
				var thHandler = state.serializer.wteHandlers.thHandler
						.bind(state.serializer.wteHandlers, node);
				return state.serializeChildren(node, thHandler);
			});
		}),
		sepnls: {
			before: function(node, otherNode, state) {
				if (otherNode.nodeName === 'TH' &&
						DU.getDataParsoid(node).stx_v === 'row') {
					// force single line
					return { min: 0, max: 2 };
				} else {
					return { min: 1, max: 2 };
				}
			},
			after: function(node, otherNode) {
				if (otherNode.nodeName === 'TD') {
					// Force a newline break
					return { min: 1, max: 2 };
				} else {
					return { min: 0, max: 2 };
				}
			},
		},
	},
	td: {
		handle: Promise.method(function(node, state, wrapperUnmodified) {
			var dp = DU.getDataParsoid(node);
			var usableDP = stxInfoValidForTableCell(state, node);
			var startTagSrc = usableDP ? dp.startTagSrc : "";
			var attrSepSrc = usableDP ? dp.attrSepSrc : null;
			var src = (usableDP && dp.stx_v === 'row') ? '||' : '|';

			// If the HTML for the first td is not enclosed in a tr-tag,
			// we start a new line.  If not, tr will have taken care of it.
			return serializeTableTag(startTagSrc || src, attrSepSrc || null,
					state, node, wrapperUnmodified).then(function(tableTag) {
				// FIXME: bad state hack!
				if (tableTag.length > 1) {
					state.inWideTD = true;
				}
				WTSUtils.emitStartTag(tableTag, node, state);
				var tdHandler = state.serializer.wteHandlers.tdHandler
						.bind(state.serializer.wteHandlers, node);
				return state.serializeChildren(node, tdHandler)
						.then(function() {
					// FIXME: bad state hack!
					state.inWideTD = undefined;
				});
			});
		}),
		sepnls: {
			before: function(node, otherNode, state) {
				if (otherNode.nodeName === 'TD' &&
						DU.getDataParsoid(node).stx_v === 'row') {
					// force single line
					return { min: 0, max: 2 };
				} else {
					return { min: 1, max: 2 };
				}
			},
			after: id({ min: 0, max: 2 }),
		},
	},
	caption: {
		handle: Promise.method(function(node, state, wrapperUnmodified) {
			var dp = DU.getDataParsoid(node);
			// Serialize the tag itself
			return serializeTableTag(dp.startTagSrc || '|+', null, state, node,
					wrapperUnmodified).then(function(tableTag) {
				WTSUtils.emitStartTag(tableTag, node, state);
				return state.serializeChildren(node);
			});
		}),
		sepnls: {
			before: function(node, otherNode) {
				return otherNode.nodeName !== 'TABLE' ?
					{ min: 1, max: 2 } : { min: 0, max: 2 };
			},
			after: id({ min: 1, max: 2 }),
		},
	},
	// Insert the text handler here too?
	'#text': { },
	p: {
		// Counterintuitive but seems right.
		// Otherwise the generated wikitext will parse as an indent-pre
		// escapeWikitext nowiking will deal with leading space for content
		// inside the p-tag, but forceSOL suppresses whitespace before the p-tag.
		forceSOL: true,
		handle: Promise.method(function(node, state, wrapperUnmodified) {
			// XXX: Handle single-line mode by switching to HTML handler!
			return state.serializeChildren(node);
		}),
		sepnls: {
			before: function(node, otherNode, state) {
				var otherNodeName = otherNode.nodeName;
				var tableCellOrBody = new Set(['TD', 'TH', 'BODY']);
				if (node.parentNode === otherNode &&
					(DU.isListItem(otherNode) || tableCellOrBody.has(otherNodeName))) {
					if (tableCellOrBody.has(otherNodeName)) {
						return { min: 0, max: 1 };
					} else {
						return { min: 0, max: 0 };
					}
				} else if (
					otherNode === DU.previousNonDeletedSibling(node) &&
					// p-p transition
					(otherNodeName === 'P' && DU.getDataParsoid(otherNode).stx !== 'html') ||
					// Treat text/p similar to p/p transition
					(
						DU.isText(otherNode) &&
						otherNode === DU.previousNonSepSibling(node) &&
						// A new wikitext line could start at this P-tag. We have to figure out
						// if 'node' needs a separation of 2 newlines from that P-tag. Examine
						// previous siblings of 'node' to see if we emitted a block tag
						// there => we can make do with 1 newline separator instead of 2
						// before the P-tag.
						!currWikitextLineHasBlockNode(state.currLine, otherNode)
					)
				) {
					return { min: 2, max: 2 };
				} else if (DU.isText(otherNode) ||
					(DU.isBlockNode(otherNode) && node.parentNode === otherNode) ||
					// new p-node added after sol-transparent wikitext should always
					// get serialized onto a new wikitext line.
					(DU.emitsSolTransparentSingleLineWT(state.env, otherNode) && DU.isNewElt(node))
				) {
					return { min: 1, max: 2 };
				} else {
					return { min: 0, max: 2 };
				}
			},
			after: function(node, otherNode, state) {
				if (!(node.lastChild && node.lastChild.nodeName === 'BR') &&
					otherNode.nodeName === 'P' && DU.getDataParsoid(otherNode).stx !== 'html' &&
						// A new wikitext line could start at this P-tag. We have to figure out
						// if 'node' needs a separation of 2 newlines from that P-tag. Examine
						// previous siblings of 'node' to see if we emitted a block tag
						// there => we can make do with 1 newline separator instead of 2
						// before the P-tag.
					(!currWikitextLineHasBlockNode(state.currLine, node, true)
						// Since we are going to emit newlines before the other P-tag, we know it
						// is going to start a new wikitext line. We have to figure out if 'node'
						// needs a separation of 2 newlines from that P-tag. Examine following
						// siblings of 'node' to see if we might emit a block tag there => we can
						// make do with 1 newline separator instead of 2 before the P-tag.
					&& !newWikitextLineMightHaveBlockNode(otherNode))
					) {
					return { min: 2, max: 2 };
				} else if (DU.isText(otherNode) || (DU.isBlockNode(otherNode) && node.parentNode === otherNode)) {
					return { min: 1, max: 2 };
				} else {
					return { min: 0, max: 2 };
				}
			},
		},
	},
	// Wikitext indent pre generated with leading space
	pre: {
		handle: Promise.method(function(node, state, wrapperUnmodified) {
			// Handle indent pre

			// XXX: Use a pre escaper?
			return state.serializeIndentPreChildrenToString(node)
					.then(function(content) {
				// Strip (only the) trailing newline
				var trailingNL = content.match(/\n$/);
				content = content.replace(/\n$/, '');

				// Insert indentation
				var solRE = JSUtils.rejoin(
					'(\\n(',
						// SSS FIXME: What happened to the includeonly seen
						// in wts.separators.js?
						Util.COMMENT_REGEXP,
					')*)',
					{ flags: 'g' }
				);
				content = ' ' + content.replace(solRE, '$1 ');

				// But skip "empty lines" (lines with 1+ comment and
				// optional whitespace) since empty-lines sail through all
				// handlers without being affected.
				//
				// See empty_line_with_comments rule in pegTokenizer.pegjs.txt
				//
				// We could use 'split' to split content into lines and
				// selectively add indentation, but the code will get
				// unnecessarily complex for questionable benefits. So, going
				// this route for now.
				var emptyLinesRE = JSUtils.rejoin(
					// This space comes from what we inserted earlier
					/(^|\n) /,
					'((?:',
						/[ \t]*/,
						Util.COMMENT_REGEXP,
						/[ \t]*/,
					')+)',
					/(?=\n|$)/
				);
				content = content.replace(emptyLinesRE, '$1$2');

				state.emitChunk(content, node);

				// Preserve separator source
				state.setSep((trailingNL && trailingNL[0]) || '');
			});
		}),
		sepnls: {
			before: function(node, otherNode) {
				if (otherNode.nodeName === 'PRE' &&
					DU.getDataParsoid(otherNode).stx !== 'html') {
					return {min: 2};
				} else {
					return {min: 1};
				}
			},
			after: function(node, otherNode) {
				if (otherNode.nodeName === 'PRE' &&
					DU.getDataParsoid(otherNode).stx !== 'html') {
					return {min: 2};
				} else {
					return {min: 1};
				}
			},
			firstChild: id({}),
			lastChild: id({}),
		},
	},
	// HTML pre
	pre_html: {
		handle: Promise.method(function(node, state, wrapperUnmodified) {
			return _htmlElementHandler(node, state);
		}),
		sepnls: {
			before: id({}),
			after: id({}),
			firstChild: id({ max: Number.MAX_VALUE }),
			lastChild:  id({ max: Number.MAX_VALUE }),
		},
	},
	meta: {
		handle: Promise.method(function(node, state, wrapperUnmodified) {
			var type = node.getAttribute('typeof');
			var property = node.getAttribute('property');
			var dp = DU.getDataParsoid(node);

			// Check for property before type so that page properties with
			// templated attrs roundtrip properly.
			// Ex: {{DEFAULTSORT:{{echo|foo}} }}
			if (property) {
				var switchType = property.match(/^mw\:PageProp\/(.*)$/);
				if (switchType) {
					var cat = switchType[1].match(/^(?:category)?(.*)/);
					var p;
					if (cat && Util.magicMasqs.has(cat[1])) {
						p = state.serializer.serializedAttrVal(node, 'content',
								{}).then(function(contentInfo) {
							if (dp.src) {
								return dp.src.replace(/^([^:]+:)(.*)$/,
									"$1" + contentInfo.value + "}}");
							} else {
								var magicWord = cat[1].toUpperCase();
								state.env.log("warning", cat[1] +
									' is missing source. Rendering as ' +
									magicWord + ' magicword');
								return "{{" + magicWord + ":" +
									contentInfo.value + "}}";
							}
						});
					} else {
						p = Promise.resolve().then(function() {
							return state.env.conf.wiki.getMagicWordWT(
								switchType[1], dp.magicSrc) || '';
						});
					}
					return p.then(function(out) {
						state.emitChunk(out, node);
					});
				} else {
					return _htmlElementHandler(node, state);
				}
			} else if (type) {
				switch (type) {
				case 'mw:Includes/IncludeOnly':
					state.emitChunk(dp.src, node);
					break;
				case 'mw:Includes/IncludeOnly/End':
					// Just ignore.
					break;
				case 'mw:Includes/NoInclude':
					state.emitChunk(dp.src || '<noinclude>', node);
					break;
				case 'mw:Includes/NoInclude/End':
					state.emitChunk(dp.src || '</noinclude>', node);
					break;
				case 'mw:Includes/OnlyInclude':
					state.emitChunk(dp.src || '<onlyinclude>', node);
					break;
				case 'mw:Includes/OnlyInclude/End':
					state.emitChunk(dp.src || '</onlyinclude>', node);
					break;
				case 'mw:DiffMarker':
				case 'mw:Separator':
					// just ignore it
					break;
				default:
					return _htmlElementHandler(node, state);
				}
			} else {
				return _htmlElementHandler(node, state);
			}
		}),
		sepnls: {
			before: function(node, otherNode) {
				var type = node.getAttribute('typeof') || node.getAttribute('property');
				if (type && type.match(/mw:PageProp\/categorydefaultsort/)) {
					if (otherNode.nodeName === 'P' && DU.getDataParsoid(otherNode).stx !== 'html') {
						// Since defaultsort is outside the p-tag, we need 2 newlines
						// to ensure that it go back into the p-tag when parsed.
						return { min: 2 };
					} else {
						return { min: 1 };
					}
				} else if (DU.isNewElt(node) &&
					// Placeholder metas don't need to be serialized on their own line
					(node.nodeName !== "META" ||
					!/(^|\s)mw:Placeholder(\/|$)/.test(node.getAttribute("typeof")))) {
					return { min: 1 };
				} else {
					return {};
				}
			},
			after: function(node, otherNode) {
				// No diffs
				if (DU.isNewElt(node) &&
					// Placeholder metas don't need to be serialized on their own line
					(node.nodeName !== "META" ||
					!/(^|\s)mw:Placeholder(\/|$)/.test(node.getAttribute("typeof")))) {
					return { min: 1 };
				} else {
					return {};
				}
			},
		},
	},
	span: {
		handle: Promise.method(function(node, state, wrapperUnmodified) {
			var type = node.getAttribute('typeof');
			if (isRecognizedSpanWrapper(type)) {
				if (type === 'mw:Nowiki') {
					state.emitChunk('<nowiki>', node);
					return Promise.reduce(Array.from(node.childNodes), function(_, child) {
						if (DU.isElt(child)) {
							if (DU.isMarkerMeta(child, "mw:DiffMarker")) {
								return;
							} else if (child.nodeName === 'SPAN' &&
									child.getAttribute('typeof') === 'mw:Entity') {
								return state.serializer._serializeNode(child);
							} else {
								state.emitChunk(child.outerHTML, node);
								return;
							}
						} else if (DU.isText(child)) {
							state.emitChunk(DU.escapeNowikiTags(child.nodeValue), child);
							return;
						} else {
							return state.serializer._serializeNode(child);
						}
					}, null).then(function() {
						WTSUtils.emitEndTag('</nowiki>', node, state);
					});
				} else if (/(?:^|\s)mw\:Image(\/(Frame|Frameless|Thumb))?/.test(type)) {
					return state.serializer.figureHandler(node);
				} else if (/(?:^|\s)mw\:Entity/.test(type) && node.childNodes.length === 1) {
					// handle a new mw:Entity (not handled by selser) by
					// serializing its children
					if (DU.isText(node.firstChild)) {
						state.emitChunk(
							Util.entityEncodeAll(node.firstChild.nodeValue),
							node.firstChild);
						return;
					} else {
						return state.serializeChildren(node);
					}
				} else if (/(^|\s)mw:Placeholder(\/\w*)?/.test(type)) {
					if (/(^|\s)mw:Placeholder(\s|$)/ &&
						node.childNodes.length === 1 &&
						DU.isText(node.firstChild) &&
						// See the DisplaySpace hack in the urltext rule
						// in the tokenizer.
						/\u00a0+/.test(node.firstChild.nodeValue)
					) {
						state.emitChunk(
							' '.repeat(node.firstChild.nodeValue.length),
							node.firstChild);
						return;
					} else {
						return _htmlElementHandler(node, state);
					}
				}
			} else {
				var dp = DU.getDataParsoid(node);
				var kvs = DU.getAttributeKVArray(node).filter(function(kv) {
					return !/^data-parsoid/.test(kv.k) &&
						!(kv.k === 'id' && /^mw[\w-]{2,}$/.test(kv.v));
				});
				if (!state.rtTestMode && dp.misnested && dp.stx !== 'html' &&
						!kvs.length) {
					// Discard span wrappers added to flag misnested content.
					// Warn since selser should have reused source.
					state.env.log('warning',
						'Serializing misnested content: ' + node.outerHTML);
					return state.serializeChildren(node);
				} else {
					// Fall back to plain HTML serialization for spans created
					// by the editor.
					return _htmlElementHandler(node, state);
				}
			}
		}),
	},
	figure: {
		handle: Promise.method(function(node, state, wrapperUnmodified) {
			return state.serializer.figureHandler(node);
		}),
		sepnls: {
			// TODO: Avoid code duplication
			before: function(node) {
				if (
					DU.isNewElt(node) &&
					node.parentNode &&
					DU.isBody(node.parentNode)
				) {
					return { min: 1 };
				}
				return {};
			},
			after: function(node) {
				if (
					DU.isNewElt(node) &&
					node.parentNode &&
					DU.isBody(node.parentNode)
				) {
					return { min: 1 };
				}
				return {};
			},
		},
	},
	img: {
		handle: Promise.method(function(node, state, wrapperUnmodified) {
			if (node.getAttribute('rel') === 'mw:externalImage') {
				state.serializer.emitWikitext(node.getAttribute('src') || '', node);
			} else {
				return state.serializer.figureHandler(node);
			}
		}),
	},
	hr: {
		handle: Promise.method(function(node, state, wrapperUnmodified) {
			state.emitChunk('-'.repeat(4 + (DU.getDataParsoid(node).extra_dashes || 0)), node);
		}),
		sepnls: {
			before: id({ min: 1, max: 2 }),
			// XXX: Add a newline by default if followed by new/modified content
			after: id({ min: 0, max: 2 }),
		},
	},
	h1: buildHeadingHandler("="),
	h2: buildHeadingHandler("=="),
	h3: buildHeadingHandler("==="),
	h4: buildHeadingHandler("===="),
	h5: buildHeadingHandler("====="),
	h6: buildHeadingHandler("======"),
	br: {
		handle: Promise.method(function(node, state, wrapperUnmodified) {
			if (DU.getDataParsoid(node).stx === 'html' || node.parentNode.nodeName !== 'P') {
				state.emitChunk('<br>', node);
			} else {
				// Trigger separator
				if (state.sep.constraints && state.sep.constraints.min === 2 &&
						node.parentNode.childNodes.length === 1) {
					// p/br pair
					// Hackhack ;)

					// SSS FIXME: With the change I made, the above check can be simplified
					state.sep.constraints.min = 2;
					state.sep.constraints.max = 2;
					state.emitChunk('', node);
				} else {
					state.emitChunk('', node);
				}
			}
		}),
		sepnls: {
			before: function(node, otherNode) {
				if (otherNode === node.parentNode && otherNode.nodeName === 'P') {
					return { min: 1, max: 2 };
				} else {
					return {};
				}
			},
			after: function(node, otherNode) {
				// List items in wikitext dont like linebreaks.
				//
				// This seems like the wrong place to make this fix.
				// To handle this properly and more generically / robustly,
				// * we have to buffer output of list items,
				// * on encountering list item close, post-process the buffer
				//   to eliminate any newlines.
				if (DU.isListItem(node.parentNode)) {
					return {};
				} else {
					return id({ min: 1 })();
				}
			},
		},
	},
	a:  {
		handle: Promise.method(function(node, state, wrapperUnmodified) {
			return state.serializer.linkHandler(node);
		}),
		// TODO: Implement link tail escaping with nowiki in DOM handler!
	},
	link:  {
		handle: Promise.method(function(node, state, wrapperUnmodified) {
			return state.serializer.linkHandler(node);
		}),
		sepnls: {
			before: function(node, otherNode) {
				if (DU.isSolTransparentLink(node) &&
					((DU.isNewElt(node) && !DU.isBody(otherNode)) ||
					DU.isDocumentFragment(node.parentNode))
				) { // Fresh category link: Serialize on its own line
					return { min: 1 };
				} else {
					return {};
				}
			},
			after: function(node, otherNode) {
				if (DU.isSolTransparentLink(node) &&
					((DU.isNewElt(node) && !DU.isBody(otherNode)) ||
					DU.isDocumentFragment(node.parentNode))
				) { // Fresh category link: Serialize on its own line
					return { min: 1 };
				} else {
					return {};
				}
			},
		},
	},
	body: {
		handle: Promise.method(function(node, state, wrapperUnmodified) {
			// Just serialize the children
			return state.serializeChildren(node);
		}),
		sepnls: {
			firstChild: id({ min: 0, max: 1 }),
			lastChild: id({ min: 0, max: 1 }),
		},
	},
});

/**
 * Function returning `domHandler`s for nodes with encapsulated content.
 */
var _getEncapsulatedContentHandler = function(n) {
	var self = this;
	var env = this.env;
	var dp = DU.getDataParsoid(n);
	var typeOf = n.getAttribute('typeof') || '';

	if (DU.isFirstEncapsulationWrapperNode(n)) {
		return {
			handle: Promise.method(function(node, state, wrapperUnmodified) {
				var src, p, dataMW;
				if (/(?:^|\s)mw:Transclusion(?=$|\s)/.test(typeOf)) {
					dataMW = DU.getDataMw(node);
					if (dataMW.parts) {
						p = self._buildTemplateWT(node, dataMW.parts);
					} else if (dp.src) {
						env.log("error", "data-mw missing in: " + node.outerHTML);
						p = Promise.resolve(dp.src);
					} else {
						throw new Error("Cannot serialize transclusion without data-mw.parts or data-parsoid.src.");
					}
				} else if (/(?:^|\s)mw:Param(?=$|\s)/.test(typeOf)) {
					if (dp.src) {
						p = Promise.resolve(dp.src);
					} else {
						throw new Error("No source for params.");
					}
				} else if (/(?:^|\s)mw:Extension\/LabeledSectionTransclusion/.test(typeOf)) {
					// FIXME: Special case for <section> until LST is
					// implemented natively in Parsoid
					if (dp.src) {
						src = dp.src;
					} else if (typeOf.match('begin')) {
						src = '<section begin="' + node.getAttribute('content') + '" />';
					} else if (typeOf.match('end')) {
						src = '<section end="' + node.getAttribute('content') + '" />';
					} else {
						env.log("error", "LST <section> without content in: " + node.outerHTML);
						src = '<section />';
					}
					p = Promise.resolve(src);
				} else if (/(?:^|\s)mw:Extension\//.test(typeOf)) {
					dataMW = DU.getDataMw(node);
					if (dataMW.name) {
						if (dp.autoInsertedRefs && state.rtTestMode) {
							// Eliminate auto-inserted <references /> noise
							// in rt-testing
							p = Promise.resolve('');
						} else {
							p = self._buildExtensionWT(node, dataMW);
						}
					} else if (dp.src) {
						env.log("error", "data-mw missing in: " + node.outerHTML);
						p = Promise.resolve(dp.src);
					} else {
						// If there was no typeOf name, and no dp.src, try getting
						// the name out of the mw:Extension type. This will
						// generate an empty extension tag, but it's better than
						// just an error.
						var extGivenName = typeOf.replace(/(?:^|\s)mw:Extension\/([^\s]+)/, "$1");
						if (extGivenName) {
							env.log("error", "no data-mw name for extension in: ", node.outerHTML);
							dataMW.name = extGivenName;
							p = self._buildExtensionWT(node, dataMW);
						} else {
							throw new Error("Cannot serialize extension without data-mw.name or data-parsoid.src.");
						}
					}
				} else {
					throw new Error("Should never reach here");
				}

				return p.then(function(s) {
					state.singleLineContext.disable();
					self.emitWikitext(s, node);
					state.singleLineContext.pop();
					return DU.skipOverEncapsulatedContent(node);
				});
			}),
			sepnls: {
				// XXX: This is questionable, as the template can expand
				// to newlines too. Which default should we pick for new
				// content? We don't really want to make separator
				// newlines in HTML significant for the semantics of the
				// template content.
				before: function(node, otherNode) {
					if (DU.isNewElt(node)
							&& /(?:^|\s)mw:Extension\/references(?:\s|$)/
								.test(typeOf)
							// Only apply to plain references tags
							&& !/(?:^|\s)mw:Transclusion(?:\s|$)/
								.test(typeOf)) {
						// Serialize new references tags on a new line
						return { min: 1, max: 2 };
					} else {
						return { min: 0, max: 2 };
					}
				},
			},
		};
	}

	if (dp.src !== undefined) {
		// Uneditable forms wrapped with mw:Placeholder tags
		// OR unedited nowikis
		if (/(^|\s)mw:Placeholder(\/\w*)?$/.test(typeOf) ||
				(typeOf === "mw:Nowiki" && n.textContent === dp.src)) {
			// implement generic src round-tripping:
			// return src, and drop the generated content
			return {
				handle: Promise.method(function(node, state, wrapperUnmodified) {
					if (/<nowiki\s*\/>/.test(dp.src)) {
						state.hasSelfClosingNowikis = true;
					}
					// FIXME: Should this also check for tabs and plain space
					// chars interspersed with newlines?
					if (dp.src.match(/^\n+$/)) {
						state.setSep((state.sep.src || '') + dp.src);
					} else {
						self.emitWikitext(dp.src, node);
					}
				}),
			};
		}

		// Entities
		if (typeOf === "mw:Entity" && n.childNodes.length === 1) {
			var contentSrc = n.textContent || n.innerHTML;
			return {
				handle: Promise.method(function(node, state, wrapperUnmodified) {
					if (contentSrc === dp.srcContent) {
						self.emitWikitext(dp.src, node);
					} else {
						self.emitWikitext(contentSrc, node);
					}
				}),
			};
		}
	}

	return null;
};


/**
 * Just the handle for the htmlElementHandler defined below.
 * It's used as a fallback in some of the tagHandlers above.
 */
_htmlElementHandler = Promise.method(function(node, state, wrapperUnmodified) {
	var serializer = state.serializer;

	// Wikitext supports the following list syntax:
	//
	//    * <li class="a"> hello world
	//
	// The "LI Hack" gives support for this syntax, and we need to
	// specially reconstruct the above from a single <li> tag.
	serializer._handleLIHackIfApplicable(node);

	return serializer._serializeHTMLTag(node, wrapperUnmodified)
			.then(function(tag) {
		WTSUtils.emitStartTag(tag, node, state);

		var p;
		if (node.childNodes.length) {
			var inPHPBlock = state.inPHPBlock;
			if (Util.tagOpensBlockScope(node.nodeName.toLowerCase())) {
				state.inPHPBlock = true;
			}

			if (node.nodeName === 'PRE') {
				// Handle html-pres specially
				// 1. If the node has a leading newline, add one like it (logic copied from VE)
				// 2. If not, and it has a data-parsoid strippedNL flag, add it back.
				// This patched DOM will serialize html-pres correctly.

				var lostLine = '';
				var fc = node.firstChild;
				if (fc && DU.isText(fc)) {
					var m = fc.nodeValue.match(/^\n/);
					lostLine = m && m[0] || '';
				}

				if (!lostLine && DU.getDataParsoid(node).strippedNL) {
					lostLine = '\n';
				}

				state.emitChunk(lostLine, node);
			}

			p = state.serializeChildren(node).then(function() {
				state.inPHPBlock = inPHPBlock;
			});
		} else {
			p = Promise.resolve();
		}

		return p.then(function() {
			return serializer._serializeHTMLEndTag(node, wrapperUnmodified);
		}).then(function(endTag) {
			WTSUtils.emitEndTag(endTag, node, state);
		});
	});
});

var htmlElementHandler = { handle: _htmlElementHandler };


if (typeof module === "object") {
	module.exports.tagHandlers = tagHandlers;
	module.exports.htmlElementHandler = htmlElementHandler;
	module.exports._getEncapsulatedContentHandler =
			_getEncapsulatedContentHandler;
}
