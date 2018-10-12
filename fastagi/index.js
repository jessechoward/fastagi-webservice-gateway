const net = require('net');
const EventEmitter = require('events').EventEmitter;
const AGISession = require('./session');

/**
 * default listening options for the server
 */
const defaultOptions =
{
	host: 'localhost',
	port: '4000'
};

class AGIServer extends EventEmitter
{
	/**
	 * Start listening for new connections
	 * @param {object} listenOptions this object is passed directly to net.server.listen
	 */
	constructor(listenOptions)
	{
		super();

		const options = Object.assign({}, defaultOptions, listenOptions);
		this.server = net.createServer();
		this.server.on('listening', this.onListening.bind(this));
		this.server.on('connection', this.onConnection.bind(this));
		this.server.on('close', this.onClose.bind(this));
		this.server.on('error', this.onError.bind(this));
		this.server.listen(options);
		this.sessions = {};
	}

	/**
	 * event handler for when the server socket emits the 'listening' event
	 */
	onListening()
	{
		console.log('AGI Server listening', this.server.address());
		this.emit('listening', this.server.address());
	}

	/**
	 * event handler for new connection requests
	 * @param {net.socket} socket the client connection socket
	 */
	onConnection(socket)
	{
		const session = new AGISession(socket);
		this.sessions[session.id] = session;
		session.on('closed', this._removeSession.bind(this));
		console.log('New session connection: ', session.id);
		this.emit('openSession', session.id);
	}

	/**
	 * Event handler for when the AGI Server socket closes.
	 * This event is not fired until all client connections are also closed.
	 */
	onClose()
	{
		console.log('AGI Server is closing. Stopping application.');
		// this shuts down the application
		process.exit();
	}

	/**
	 * Handle net.server socket errors. These stop the server socket from accepting new
	 * requests and ultimately cause the application to close
	 * @param {object} error the error emitted from the AGI server socket
	 */
	onError(error)
	{
		console.log('AGI Server socket error: ', error);
		this.close();
		this.emit('error', error);
	}

	/**
	 * remove a closed session from the sessions list
	 * @param {string} sessionId 
	 */
	_removeSession(sessionId)
	{
		if (this.sessions[sessionId])
		{
			delete this.sessions[sessionId];
			this.emit('closeSession', sessionId);
		}
	}

	/**
	 * Stop the server from accepting new connections.
	 * 
	 * @param {boolean} [graceful=true] When graceful is true(default) the server will allow all connections to complete.
	 * 									When false, the server will forcefully terminate all active connections regardless of state.
	 */
	stopServer(graceful=true)
	{
		// this stops the server from accepting new connections
		this.server.close();
		// check if we are to forcefully exit
		if (!graceful)
		{
			// set the exit code to failure if we need to exit forcefully
			process.exitCode = -1;
			// loop through the sessions and close them forcefully
			for (let id of Object.keys(this.sessions))
			{
				this.sessions[id].close();
			}
		}
	}
}

module.exports = AGIServer;
