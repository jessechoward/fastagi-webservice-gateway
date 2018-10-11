const hostname = require('os').hostname();
const winston = require('winston');
const pkg = require('./package.json');

// the log level should be set by an environment variable
// defaults to debug for development, production should set
// this to warning or error
const log_level = process.env.LOG_LEVEL || 'debug';

const appInfo = winston.format((info) =>
{
	info.app_info =
	{
		app_name: pkg.name,
		version: pkg.version,
		node_env: process.env.NODE_ENV || 'undefined',
		log_level: log_level,
		host: hostname,
		pid: process.pid,
		uptime: process.uptime()
	};

	return info;
});

const logger = winston.createLogger(
{
	// silence logging if we are running unit tests
	silent: process.env.NODE_ENV === 'UNIT_TESTING' ? true : false,
	// use syslog levels of logging
	levels: winston.config.syslog.levels,
	level: log_level,
	// set the format of the logging
	format: winston.format.combine
	(
		// add some basic app info
		appInfo(),
		winston.format.timestamp(),
		winston.format.json()
//		winston.format.prettyPrint({depth: 1})
//		winston.format.logstash()
	),
	transports:
	[
		new winston.transports.Console()/*,
		winston.transports.File() */
	]
});

// export an instance of the logger
// takes advantage of caching so
// each time "require('path/logging');" is called it
// return the same instance
module.exports = logger;
