const EventEmitter = require('events').EventEmitter;
const crypto = require('crypto');
const logger = require('../logging');

const EndOfVars = /\n\n$/;
const EndOfMessage = /\n$/;
const Hangup = /^HANGUP\s*$/gm;
const ResponseMessage = /^(\d{3})(?:(?: result=(\S+)(.+\n)*)|(?:-(.*\n)))$/gm;
const AgiVar = /^agi_(\S+): (.+)$/;

const validStates = ['init', 'idle', 'writing', 'wait_response', 'hangup', 'closed'];

// generate a sufficient uid (not necessarily a uuid/guid!)
const uid = () =>
{
	return crypto.randomBytes(16).toString('hex');
};

class AGISession extends EventEmitter
{
	constructor(socket)
	{
		super();
		// the socket
		this._socket = socket;
		// turn of nagling
		this._socket.setNoDelay(true);
		// make sure we return utf-8 strings and not buffers
		this._socket.setEncoding('utf8');
		// set the id to a sufficiently random 128 bit hex string
		this._id = uid();
		// the buffer used to capture input from Asterisk
		this._inbuffer = '';
		// the session state
		this._state = 'init';
		// the channel vars passed to the session on init
		this._vars = {};

		// net.socket event handlers
		// https://nodejs.org/api/net.html#net_event_close_1
		this._socket.on('close', () => {this.updateState('closed');});
		this._socket.on('data', this.inputHandler.bind(this));
		this._socket.on('end', this.close.bind(this));
		this._socket.on('error', this.errorHandler.bind(this));
		this._socket.on('timeout', this.timeoutHandler.bind(this));

		// set a timeout for socket inactivity
		// the default is 5 seconds.
		// be sure to close the socket on the timeout event handler above
		this._timer = this._socket.setTimeout(process.env.SESSION_TIMEOUT || 5000);

		logger.info('New session', this.session);
	}

	// read-only: get the session id
	get id() {return this._id;}
	// read-only: get the session state
	get state() {return this._state;}
	// read-only: get the number of bytes read from Asterisk during the session
	get bytesRead() {return this._socket.bytesRead;}
	// read-only: get the number of bytes written to asterisk during the session
	get bytesWritten() {return this._socket.bytesWritten;}
	// read-only: get an array of the channel vars Asterisk sent at connection time
	get vars(){return this._vars;}
	// read-only: get a summary of the session
	// used mostly for logging
	get session()
	{
		return {
			// the session id
			id: this.id,
			// state of the session per this application
			// this is not tied to Asterisk or any other state
			state: this.state,
			// arg_1 should always be the ip/hostname/fqdn of the Asterisk server
			asterisk: this.vars.arg_1,
			// the channel on the Asterisk server in case we need to inspect it later
			channel: this.vars.channel,
			// the network script 'agi://<agi_server>:<port>/<network_script>'
			script: this.vars.network_script,
			// the context this extension was executed from
			context: this.vars.context,
			// the extension in the dialplan that is executing this script
			extension: this.vars.extension,
			// mostly for debugging - the bytes read/written on the line
			bytes: {read: this.bytesRead, write: this.bytesWritten}
		};
	}

	/**
	 * close the socket and let Asterisk continue in the dialplan
	 * probably the most important part of the session is to close the socket
	 * difinitively as that is what triggers asterisk to take back control
	 * @param {*} [args] optional error/message to log
	 */
	close(args)
	{
		if (args) logger.debug('Closing arguments', {session: this.session, args: args});
		this.updateState('closed');
		this._socket.destroy();
	}

	/**
	 * update the session state and emit status change events
	 * @param {string} newState the new state of the session
	 */
	updateState(newState)
	{
		newState = newState.toLowerCase();
		const msg = {old_state: this.state, new_state: newState};
		logger.debug('Changing state', msg);

		if (!validStates.includes(newState))
		{
			logger.error('Trying to update to bad state', msg);
			return;
		}

		if (this.state !== newState)
		{
			this._state = newState;
			this.emit('stateChange', msg);
			if (this.state === 'closed') this.emit('closed');
		}
	}

	/**
	 * check if the session is closed
	 * @returns {boolean} true if the session is closed or we received a HANGUP from Asterisk
	 */
	_checkHangup()
	{
		// check for hangup
		if (this.state === 'closed' || Hangup.test(this._inbuffer))
		{
			logger.info('Hangup detected');
			this.close();
			return true;
		}

		return false;
	}

	/**
	 * Parse the channel vars received from Asterisk on connection.
	 * Populate the _vars{} object
	 * @param {string} data the contents of the inbuffer
	 */
	_parseVars(data)
	{
		const vars = data.split('\n');
		for (let item = 0; item < vars.length; item++)
		{
			const parts = vars[item].trim().match(AgiVar);
			if (parts) this._vars[parts[1]] = parts[2];
		}
	}

	/**
	 * Handle the socket.data events
	 * @param {string} data utf-8 string read from the socket
	 */
	inputHandler(data)
	{
		// capture the data
		this._inbuffer += data;

		logger.debug('session data received', {data: data, eol: EndOfMessage.test(this._inbuffer)});
		// check for hangup
		if (this._checkHangup()) return;

		// the inbuffer should always end in at least a single newline
		if (!EndOfMessage.test(this._inbuffer)) return;

		switch (this._state)
		{
			case 'init':
				// AGI initially sends a list of channel variables
				// ending with a final double newline. Make sure this
				// exists in the buffer
				if (!EndOfVars.test(this._inbuffer)) {logger.debug('No end of vars'); return;}
				// parse the vars
				this._parseVars(this._inbuffer);
				// clear the inbuffer
				this._inbuffer = '';
				// update the state of the connection
				this.updateState('idle');
				// emit a ready event to tell the managing process
				// that it is okay to start sending commands
				this.emit('ready');
				return;

			case 'wait_response':
			{
				console.log('wait response');
				// this makes sure the inbuffer more closely matches a full response
				// based on information here https://www.voip-info.org/asterisk-agi/#AGIExecutionEnvironment
				// and testing of live responses
				const response = ResponseMessage.exec(this._inbuffer);
				console.log('Matched response: ', response);
				if (response)
				{
					const  msg =
					{
						code: parseInt(response[1]),
						result: response[2],
						data: !response[3] ? [] : response[3].trim().split('\n')
					};
					// emit the response
					this.emit('response', response);
					this.updateState('idle');
					logger.debug('Response status', {response: msg});
				}
				return;
			}
			//case 'idle':
			//case 'writing':
			//case 'hangup':
			//case 'closed':
			default:
				// throw it away because we don't expect it during these alternate states
				// this is also why checking for HANGUP is done before the switch/case
				logger.warning('Throwing away unexpected data', {session: this.session, data: this._inbuffer});
				this._inbuffer = '';
				return;
		}
	}

	/**
	 * Handle socket error events
	 * @param {*} error handle the socket error as thrown
	 */
	errorHandler(error)
	{
		// set a socket error flag other async events can check for
		this._socket_error = true;
		logger.error('Socket error', {session: this.session, error: error});
		// explicitly close the socket on error
		// even though the documentation says this event is immediately
		// followed by a close event
		this.close();
	}

	/**
	 * Close the socket if it has idled out
	 */
	timeoutHandler()
	{
		this._socket_error = true;
		logger.error('Socket timed out from inactivity', {session: this.session});
		this.close();
	}

	/**
	 * Low-level send a newline terminated string to Asterisk
	 * in the hopes it will be a valid AGI command.
	 * The calling context of this method should handle formatting
	 * of the command.
	 * @param {string} command a newline terminated AGI command
	 * @returns {Promise} a promise that completes when the data is sent.
	 * 	The resolution of this promise has no bearing on if the command succeded or not
	 * 	only if it was sent in it's entirety and the socket did not error.
	 */
	exec(command)
	{
		return new Promise((resolve, reject) =>
		{
			if (!command || this.state !== 'idle')
			{
				return reject('Invalid command or connection not ready', {command: command, state: this.state});
			}
			// add the necessary newline if it does not exist
			if (!command.endsWith('\n')) command += '\n';
			// update our state to writing
			this.updateState('writing');
			// actually write the data to the wire
			this._socket.write(command, 'utf8', () =>
			{
				// this is unfortunate that the absence of an error object is not
				// indicative of absence of an error per the documentation
				// https://nodejs.org/api/stream.html#stream_writable_write_chunk_encoding_callback
				if (!this._socket_error)
				{
					this.updateState('wait_response');
				}
			});
		});
	}
}

module.exports = AGISession;
