'use strict';
require('../../core-upgrade.js');


/**
 * Consolidates logging data into a single flattened
 * object (flatLogObject) and exposes various methods
 * that can be used by backends to generate message
 * strings (e.g., stack trace).
 *
 * @class
 * @constructor
 * @param {String} logType Type of log being generated.
 * @param {Object} logObject Data being logged.
 */
var LogData = function(logType, logObject) {
	this.logType = logType;
	this.logObject = logObject;
	this._error = new Error();

	// Cache log information if previously constructed.
	this._cache = {};
};

/**
 * @method
 *
 * Generate a full message string consisting of a message and stack trace.
 */
LogData.prototype.fullMsg = function() {
	if (this._cache.fullMsg === undefined) {
		var messageString = this.msg();

		// Stack traces only for error & fatal
		// FIXME: This should be configurable later on.
		if (/^(error|fatal)(\/|$)?/.test(this.logType) && this.stack()) {
			messageString += '\n' + this.stack();
		}

		this._cache.fullMsg = messageString;
	}
	return this._cache.fullMsg;
};

/**
 * @method
 *
 * Generate a message string that combines all of the
 * logObject's message fields (if an originally an object)
 * or strings (if originally an array of strings)
 */
LogData.prototype.msg = function() {
	if (this._cache.msg === undefined) {
		this._cache.msg = this.flatLogObject().msg;
	}
	return this._cache.msg;
};

LogData.prototype._getStack = function() {
	// Save original Error.prepareStackTrace
	var origPrepareStackTrace = Error.prepareStackTrace;

	// Override with function that just returns `stack`
	Error.prepareStackTrace = function(_, stack) { return stack; };

	// Remove superfluous function calls on stack
	var stack = this._error.stack;
	for (var i = 0; i < stack.length - 1; i++) {
		if (/\.log \(/.test(stack[i])) {
			stack = stack.slice(i + 1);
			break;
		}
	}

	// Restore original `Error.prepareStackTrace`
	Error.prepareStackTrace = origPrepareStackTrace;

	return "Stack:\n  " + stack.join('\n  ');
};

/**
 * @method
 *
 * Generates a message string with a stack trace. Uses the
 * flattened logObject's stack trace if it exists; otherwise,
 * creates a new stack trace.
 */
LogData.prototype.stack = function() {
	if (this._cache.stack === undefined) {
		this._cache.stack = this.flatLogObject().stack === undefined
			? this._getStack() : this.flatLogObject().stack;
	}
	return this._cache.stack;
};


/**
 * @method
 *
 * Flattens the logObject array into a single object for access
 * by backends.
 */
LogData.prototype.flatLogObject = function() {
	if (this._cache.flatLogObject === undefined) {
		this._cache.flatLogObject = this._flatten(this.logObject, 'top level');
	}
	return this._cache.flatLogObject;
};

/**
 * @method
 *
 * Returns a flattened object with an arbitrary number of fields,
 * including "msg" (combining all "msg" fields and strings from
 * underlying objects) and "stack" (a stack trace, if any)
 *
 * @param {Object} o Object to flatten
 * @param {String} topLevel Separate top-level from recursive calls.
 */
LogData.prototype._flatten = function(o, topLevel) {
	var f, msg, longMsg;
	var self = this;

	if (typeof (o) === 'undefined' || o === null) {
		return { msg: '' };
	} else if (Array.isArray(o) && topLevel) {
		// flatten components, but no longer in a top-level context.
		f = o.map(function(oo) { return self._flatten(oo); });
		// join all the messages with spaces or newlines between them.
		var tobool = function(x) { return !!x; };
		msg = f.map(function(oo) { return oo.msg; }).filter(tobool).join(' ');
		longMsg = f.map(function(oo) { return oo.msg; }).filter(tobool).join('\n');
		// merge all custom fields
		f = f.reduce(function(prev, oo) {
			return Object.assign(prev, oo);
		}, {});
		return Object.assign(f, {
			msg: msg,
			longMsg: longMsg,
		});
	} else if (o instanceof Error) {
		f = {
			msg: o.message,
			// In some cases, we wish to suppress stacks when logging,
			// as indicated by `suppressLoggingStack`.
			// (E.g. see DoesNotExistError in mediawikiApiRequest.js).
			// We return a defined value to avoid generating a stack above.
			stack: o.suppressLoggingStack ? "" : o.stack,
		};
		if (o.code) {
			f.code = o.code;
		}
		return f;
	} else if (typeof (o) === 'function') {
		return self._flatten(o());
	} else if (typeof (o) === 'object' && o.hasOwnProperty('msg')) {
		return o;
	} else if (typeof (o) === 'string') {
		return { msg: o };
	} else {
		return { msg: JSON.stringify(o) };
	}
};

if (typeof module === "object") {
	module.exports.LogData = LogData;
}
