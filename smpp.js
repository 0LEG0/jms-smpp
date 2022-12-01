/**
 * JMS SMPP module
 * @author "0LEG0 <a.i.s@gmx.com>"
 * @version 1.0.1
 * 
 * Emit and handle smpp.* messages:
 * smpp.connect
 * smpp.disconnect
 * smpp.bind_*
 * smpp.unbind_*_resp
 * smpp.submit_sm
 * smpp.submit_sm_resp
 * smpp.deliver_sm
 * smpp.deliver_sm_resp
 */
"use strict";

const { connect, JMessage } = require("jms-engine");
const { v4: uuid } = require("uuid");
const jengine = connect({trackname: "smpp", selfdispatch: true});
const smpp = require("smpp");
const listeners = new Map();
const connections = new Map();
const OPTIONS = { listener: {}, connection: {} };
const CONF_FILE = process.env.PWD + "/conf/.smpp.js";
const DEFAULT = {
	listener: {
		enabled: false,
		host: "127.0.0.1", //listen address
		port: 2775, //listen port
		family: 4, //TCPv4
	},

	connection: {
		enabled: false,
		host: "127.0.0.1", //Outgoing connection address
		port: 2775, //Outgoing connection port
		family: 4, //TCPv4
		system_id: "SYSTEM_ID", //Outgoing id
		password: "PASSWORD", //Outgoing password
		type: "transceiver",
		restart: 0, //restarts after ms
		connectTimeout: 10000
	},
};

async function load() {
	// fs.accessSync(CONF_FILE, fs.constants.F_OK);
	// let config = ini.parse(fs.readFileSync(CONF_FILE, "utf-8"));
	let config = require(CONF_FILE);
	if (typeof config.listener !== "object" || config.listener == null) config.listener = {};
	if (typeof config.connection !== "object" || config.connection == null) config.connection = {};

	// Load listeners
	for (let key in config.listener) {
		OPTIONS.listener[key] = {
			...DEFAULT.listener,
			...config.listener[key],
		};
	}
	// Load connections
	for (let key in config.connection) {
		OPTIONS.connection[key] = {
			...DEFAULT.connection,
			...config.connection[key],
		};
		if (OPTIONS.connection[key].restart) OPTIONS.connection[key].restart = Number.parseInt(OPTIONS.connection[key].restart);
	}
	return OPTIONS;
}

async function start() {
	// Start listeners
	for (let key in OPTIONS.listener) {
		if (!OPTIONS.listener[key].enabled) continue;
		listeners.set(key, createListener(OPTIONS.listener[key], key));
	}
	// Start connections
	for (let key in OPTIONS.connection) {
		if (!OPTIONS.connection[key].enabled) continue;
		smppHandler(new JMessage("smpp.connect", {
			...OPTIONS.connection[key],
			connection_id: key,
			system_id: undefined,
			password: undefined,
			enabled: undefined
		}))
		.then(() => {
			// try bind after 2 sec
			setTimeout(() => {
				smppHandler(new JMessage("smpp.bind_" + OPTIONS.connection[key]?.type, {
					connection_id: key,
					system_id: OPTIONS.connection[key]?.system_id,
					password: OPTIONS.connection[key]?.password
				}))
				.then(ans => {
					if (!ans.error) {
						jengine.info("SMPP connection bound", key);
					} else {
						jengine.error("SMPP connection bound failed", key, ans.error);
					}
				})
				.catch(err => {
					jengine.error("SMPP connection bound failed", key, err);
				})
			}, 2000);
		});
	}
}

function createListener(option, id) {
	const server = smpp.createServer(option);
	server.id = id;
	server.connection_counter = 1;

	server.on("error", err => {
		jengine.enqueue({
			...option,
			name: "smpp.unlisten",
			listener_id: id,
			error: {...err},
			// handled: true // notice
		});
	});

	server.on("listening", () => {
		jengine.enqueue({
			...option,
			name: "smpp.listen",
			listener_id: id,
			result: server.address(),
			handled: true // notice
		});
	});

	server.on("close", () => {
		jengine.enqueue({
			...option,
			name: "smpp.unlisten",
			listener_id: id,
			handled: true // notice
		});
		server.removeAllListeners("listening");
		server.removeAllListeners("close");
		server.removeAllListeners("error");
		server.removeAllListeners("session");
	});
	
	server.on("session", (conn) => {
		conn.id = `${server.id}.${server.connection_counter++}`;
		//conn.restart = false;
		//conn.incoming = true;
		conn.bound = undefined;
		conn.system_id = undefined;
		conn.listener_id = server.id;
		conn.pause();
		connectionHandler(conn);
		jengine.info(`SMPP incoming connection ${conn.id} <- ${conn.socket.remoteAddress}:${conn.socket.remotePort}`);
		// <- smpp.connect - incoming
		jengine.dispatch("smpp.connect", {
				direction: "incoming",
				connection_id: conn.id,
				localAddress: conn.socket.localAddress,
				localPort: conn.socket.localPort,
				remoteAddress: conn.socket.remoteAddress,
				remotePort: conn.socket.remotePort,
				listener_id: server.id,
			})
			.catch((err) => {
				err.result = "close";
				return err;
			})
			.then((answer) => {
				if (
					(typeof answer.result == "boolean" &&
						answer.result == false) ||
					answer.result === "reject" ||
					answer.result === "no" ||
					answer.result === "close" ||
					answer.result === null || // default
					typeof answer.result == "undefined" //default
				) {
					// close
					conn.close();
					jengine.info(`SMPP connection has been closed ${conn.id} <- ${conn.socket.remoteAddress}:${conn.socket.remotePort}`);
				} else if (
					(typeof answer.result == "boolean" &&
						answer.result == true) ||
					answer.result === "accept" ||
					answer.result === "yes") {
					// accept
					//connectionHandler(conn);
					conn.resume();
					if (conn && !conn?.destroyed && !conn.closed) {
						jengine.info("SMPP connection accepted", conn.id);
						connections.set(conn.id, conn);
					}
					// drop not bound connection timer
					setTimeout((c) => {
						if (c && !c?.bound && !c?.destroyed && !c.closed) {
							jengine.warn("SMPP connection disconnected by timeout", c.id);
							jengine.enqueue("smpp.disconnect", {
								direction: "outgoing",
								connection_id: c.id,
								localAddress: c.socket.localAddress,
								localPort: c.socket.localPort,
								remoteAddress: c.socket.remoteAddress,
								remotePort: c.socket.remotePort,
								listener_id: server.id
							});
						}
					}, 10000, conn);
				}
				return answer;
			});
	});
	server.listen(option);
	return server;
}

function createConnection(option, id) {
	const client = new smpp.Session(option);
	client.id = id;
	//client.restart = option.restart;
	client.incoming = false;
	client.bound = undefined;
	client.system_id = undefined;
	connectionHandler(client);
	return client;
}

function connectionHandler(conn) {
	// <- smpp.disconnect
	conn.on("close", () => {
		jengine.info("SMPP closed connection", conn.id);
		jengine.enqueue({
			name: "smpp.disconnect",
			//direction: "outgoing",
			listener_id: conn.listener_id,
			connection_id: conn.id,
			system_id: conn.system_id,
			localAddress: conn.socket.localAddress,
			localPort: conn.socket.localPort,
			remoteAddress: conn.socket.remoteAddress,
			remotePort: conn.socket.remotePort,
			handled: true, // notice
		});
		conn.removeAllListeners("connect");
		conn.removeAllListeners("close");
		conn.removeAllListeners("error");
		conn.removeAllListeners("pdu");
		connections.delete(conn.id);
		conn.destroy();
		// Restart
		if (typeof OPTIONS.connection[conn.id]?.restart == "number" && OPTIONS.connection[conn.id]?.enabled) setTimeout(() => {
			jengine.info("SMPP restart connection", conn.id);
			smppHandler(new JMessage("smpp.connect", {
				...OPTIONS.connection[conn.id],
				connection_id: conn.id,
				system_id: undefined,
				password: undefined,
				enabled: undefined
			}))
			.then(() => {
				setTimeout(() => {
					jengine.info("SMPP rebinding connection", conn.id);
					smppHandler(new JMessage("smpp.bind_" + OPTIONS.connection[conn.id]?.type, {
						connection_id: conn.id,
						system_id: OPTIONS.connection[conn.id]?.system_id,
						password: OPTIONS.connection[conn.id]?.password
					}))
					.then(ans => {
						if (!ans.error) {
							jengine.info("SMPP connection bound", conn.id);
						} else {
							jengine.error("SMPP connection bound failed", conn.id, ans.error);
						}
					})
					.catch(err => {
						jengine.error("SMPP connection bound failed", conn.id, err);
					})
				}, 2000);
			})
		}, OPTIONS.connection[conn.id].restart);
	});

	// <- smpp.error
	conn.on("error", (err) => {
		//console.log("SMPP error connection", connection.id, err.stack);
		jengine.enqueue({
			name: "smpp.error",
			//direction: "outgoing",
			listener_id: conn.listener_id,
			connection_id: conn.id,
			system_id: conn.system_id,
			localAddress: conn.socket.localAddress,
			localPort: conn.socket.localPort,
			remoteAddress: conn.socket.remoteAddress,
			remotePort: conn.socket.remotePort,
			error: { ...err },
			handled: true, // notice
		});
	});

	// <- smpp.connect outgoing
	conn.on("connect", () => {
		jengine.info("SMPP established connection", conn.id);
		jengine.enqueue({
			name: "smpp.connect",
			direction: "outgoing",
			listener_id: conn.listener_id,
			connection_id: conn.id,
			localAddress: conn.socket.localAddress,
			localPort: conn.socket.localPort,
			remoteAddress: conn.socket.remoteAddress,
			remotePort: conn.socket.remotePort,
			handled: true, // notice
		});
	});

	// SMPP PDU
	conn.on("pdu", (pdu) => {
		switch (pdu.command) {
			// <- smpp.bind_*
			case "bind_transmitter":
			case "bind_receiver":
			case "bind_transceiver":
				conn.pause();
				jengine.dispatch({
						name: "smpp." + pdu.command,
						...pdu,
						direction: "incoming",
						listener_id: conn.listener_id,
						connection_id: conn.id,
						command_status: undefined,
					})
					.then((answer) => {
						// converting result to command_status
						let command_status = toStatusCode(answer, smpp.ESME_RBINDFAIL);

						// _resp or nothing
						if (typeof command_status == "number") {
							jengine.enqueue(`smpp.${pdu.command}_resp`, {
								sequence_number: pdu.sequence_number,
								command_status: command_status,
								direction: "outgoing",
								listener_id: conn.listener_id,
								connection_id: conn.id,
								system_id: pdu.system_id
							}).then(() => {
								if (command_status === 0) {
									conn.bound = pdu.command.substring(5);
									conn.system_id = pdu.system_id;
								} else
									jengine.enqueue("smpp.disconnect", {
										direction: "outgoing",
										listener_id: conn.listener_id,
										connection_id: conn.id,
										system_id: conn.system_id
									});
							});
						}
						conn.resume(); // !!! dont forget
					})
					.catch((err) => err);
				break;

			// <- smpp.bind_*_resp
			case "bind_transmitter_resp":
			case "bind_receiver_resp":
			case "bind_transceiver_resp":
				if (pdu.command_status == 0) {
					conn.bound = pdu.command.substring(5).slice(0, -5);
					conn.system_id = pdu.system_id;
				}
				jengine.enqueue(
					JMessage.create({
						name: "smpp." + pdu.command,
						...pdu,
						direction: "incoming",
						listener_id: conn.listener_id,
						connection_id: conn.id,
						handled: true, //notice
					})
				);
				break;

			// <- smpp.submit_sm
			case "submit_sm":
			case "deliver_sm":
				jengine.dispatch(
					JMessage.create({
						name: "smpp." + pdu.command,
						...pdu,
						direction: "incoming",
						connection_id: conn.id,
						listener_id: conn.listener_id,
						system_id: conn.system_id,
						command_status: !conn.bound
							? smpp.ESME_RINVBNDSTS
							: undefined, // status if not bound 
						handled: !conn.bound ? true : false, // request or notice if not bound
					})
				)
					.then((answer) => {
						// converting result to command_status
						let default_status = pdu.command === "submit_sm" ? smpp.ESME_RSUBMITFAIL :
											pdu.command === "deliver_sm" ? smpp.ESME_RDELIVERYFAILURE : 0

						//let command_status = toStatusCode(answer, (pdu.command === "submit_sm" ? smpp.ESME_RSUBMITFAIL : pdu.command === "deliver_sm" ? smpp.ESME_RDELIVERYFAILURE : 0) );
						let command_status = toStatusCode(answer, default_status);

						// *_resp or nothing
						if (typeof command_status === "number")
							jengine.enqueue(
								new JMessage(`smpp.${pdu.command}_resp`, {
									sequence_number: pdu.sequence_number,
									command_status: command_status,
									message_id: answer.get("message_id") ? answer.get("message_id") : uuid(),
									direction: "outgoing",
									listener_id: conn.listener_id,
									connection_id: conn.id,
									system_id: conn.system_id
								})
							);
					})
					.catch((err) => err);
				break;
			case "unbind":
				jengine.dispatch(
					JMessage.create({
						name: "smpp." + pdu.command,
						...pdu,
						direction: "incoming",
						connection_id: conn.id,
						listener_id: conn.listener_id,
						system_id: conn.system_id,
						command_status: !conn.bound
							? smpp.ESME_RINVBNDSTS
							: undefined, // status if not bound 
						handled: !conn.bound ? true : false, // request or notice if not bound
					})
				)
				.then((answer) => {
					let command_status = toStatusCode(answer, 0);
					// *_resp or nothing
					if (typeof command_status === "number")
						jengine.enqueue(
							new JMessage(`smpp.${pdu.command}_resp`, {
								sequence_number: pdu.sequence_number,
								command_status: command_status,
								direction: "outgoing",
								listener_id: conn.listener_id,
								connection_id: conn.id,
							})
						).then(() => {
							conn.bound = undefined;
							conn.system_id = undefined;
						});
					})
					.catch((err) => err);
					// Rebind
					if (typeof OPTIONS.connection[conn.id]?.restart == "number" && OPTIONS.connection[conn.id].enabled) setTimeout(() => {
						let c = connections.get(conn.id);
						if (c && !c.bound) {
							jengine.info("SMPP rebinding connection", conn.id);
							smppHandler(new JMessage("smpp.bind_" + OPTIONS.connection[conn.id]?.type, {
								connection_id: conn.id,
								system_id: OPTIONS.connection[conn.id]?.system_id,
								password: OPTIONS.connection[conn.id]?.password
							}));
						}
					}, OPTIONS.connection[conn.id].restart);
				break;
			// <- smpp.submit_sm_resp
			case "submit_sm_resp":
			case "deliver_sm_resp":
			case "unbind_resp":
				jengine.enqueue(
					JMessage.create({
						name: "smpp." + pdu.command,
						...pdu,
						direction: "incoming",
						connection_id: conn.id,
						listener_id: conn.listener_id,
						system_id: conn.system_id,
						handled: true, // notice
					})
				);
				break;
			// auto answer to enquire_link
			case "enquire_link":
				conn.send(pdu.response());
				break;
			// unhandled PDU
			default:
				jengine.warn("SMPP generic nack", pdu);
				jengine.enqueue(
					JMessage.create({
						name: "smpp.generic_nack",
						...pdu,
						direction: "outgoing",
						connection_id: conn.id,
						listener_id: conn.listener_id,
						system_id: conn.system_id
					})
				);
		}
	});
}

async function smppHandler(message) {
	//close listener
	if (message.handled || message.get("direction") === "incoming") return;
	message.handled = true;	

	// create listener
	if (message.name === "smpp.listen") {

		if (
			typeof message.get("listener_id") !== "string" ||
			message.get("listener_id") === "" ||
			listeners.has( message.get("listener_id") )
			) {
			message.type = "error";
			message.error = "Wrong listener_id.";
			return message;
		}
		return new Promise(resolve => {
			let new_conn = createListener({...DEFAULT.listener, ...message.payload }, message.get("listener_id"));
			let ok, bad;
			new_conn.once("listening", ok = () => {
				listeners.set(message.get("listener_id"), new_conn);
				new_conn.removeListener("error", bad);
				message.result = new_conn.address();
				resolve(message);
			});
			
			new_conn.once("error", bad = err => {
				message.type = "error";
				message.error = {...err};
				//message.result = "error";
				new_conn.removeListener("listening", ok);
				resolve(message);
			});
		});
	}
	// close listener
	if (message.name === "smpp.unlisten" && typeof message.get("listener_id") == "string" && message.get("listener_id") !== "") {
		let listener = listeners.get(message.get("listener_id"));
		if (listener) {
			listener.close();
			listeners.delete(message.get("listener_id"));
		} else {
			message.type = "error";
			message.error = "Listener not exist."
		}
		return message;
	}

	// create outgoing connection
	if (message.name === "smpp.connect") {
		if (typeof message.get("connection_id") !== "string" ||
			message.get("connection_id") === "" ){
			message.type = "error";
			message.error = "Wrong connection_id";
			return message;
		}
		if (connections.has(message.get("connection_id"))) {
			let conn = connections.get(message.get("connection_id"));
			message.set("listener_id", conn.listener_id);
			message.set("bound", conn.bound);
			message.set("system_id", conn.system_id);
			//message.set("incoming", conn.incoming || false);
			message.set("remoteAddress", conn.socket.remoteAddress);
			message.set("remotePort", conn.socket.remotePort);
			message.set("localAddress", conn.socket.localAddress);
			message.set("localPort", conn.socket.localPort);
			return message;
		}
		return new Promise(resolve => {
			let new_conn = createConnection({...DEFAULT.connection, ...message.payload, name: message.get("connection_id")}, message.get("connection_id"));
			let ok, bad;
			new_conn.once("connect", ok = () => {
				connections.set(message.get("connection_id"), new_conn);
				new_conn.removeListener("error", bad);
				resolve(message);
			});
			
			new_conn.once("error", bad = err => {
				message.type = "error";
				message.error = {...err};
				//message.result = "error";
				new_conn.removeListener("connect", ok);
				resolve(message);
			});
		});
	}

	// all other commands need a connection
	if (typeof message.get("connection_id") !== "string") return;
	let conn = connections.get(message.get("connection_id"));
	if (conn)
		switch (message.name) {
			case "smpp.bind_receiver":
			case "smpp.bind_receiver_resp":
			case "smpp.bind_transmitter":
			case "smpp.bind_transmitter_resp":
			case "smpp.bind_transceiver":
			case "smpp.bind_transceiver_resp":
				return new Promise(resolve => {
					let command = message.name.substring(5);
					conn[command](message.payload, (res) => {
						message.result = {...res};
						resolve(message);
					});
				});
			case "smpp.submit_sm":
			case "smpp.submit_sm_resp":
			case "smpp.deliver_sm":
			case "smpp.deliver_sm_resp":
			case "smpp.generic_nack":
			case "smpp.unbind":
			case "smpp.unbind_resp":
				if (!conn.bound) {
					message.type = "error";
					message.error = "NOTBOUND";
					return message;
				} else return new Promise(resolve => {
					let command = message.name.substring(5);
					conn[command](message.payload, (res) => {
						message.result = {...res};
						resolve(message);
					});
				});
			case "smpp.disconnect":
				conn.close();
				conn.destroy();
				return message;
			default:
				return;
		}
	message.type = "error";
	message.error = "NOCONN";
	return message;
}

async function commandHandler(message) {
	if (message.name === "jengine.status") {
		message.result = `listeners:${listeners.size};connections:${connections.size};status:on`;
		return message;
	}
	if (message.name === "jengine.command") {
		let line = message.get("line");
		if (typeof line !== "string") return;
		if (line === "help") {
			return (message.result ? message.result : "") + "\nsmpp listeners|connections";
		}
		let arg = line.split(" ");
		if (arg[0] !== "smpp") return;
		message.handled = true;
		switch (arg[1]) {
			case "listeners":
				message.result = [...listeners.values()].map((item) => {
					return { id: item.id, ...item.address() };
				});
				return message;
			case "connections":
				message.result = [...connections.values()].map((item) => {
					return { id: item.id, bound: item.bound, system_id: item.system_id };
				});
				return message;
			default:
				return "smpp listeners|connections";
		}
	}
}

function toStatusCode(message, status = 0) {
	return typeof message.get("command_status") == "number" ? message.get("command_status") :
		typeof message.result == "number" ? message.result :
		typeof message.result == "boolean" && message.result ? 0 : status;
}

async function main() {
	try {
		await load();
		await start();
		jengine.install("smpp.disconnect", smppHandler);
		jengine.install("smpp.connect", smppHandler);
		jengine.install("smpp.listen", smppHandler);
		jengine.install("smpp.unlisten", smppHandler);
		jengine.install("smpp.unbind", smppHandler);
		jengine.install("smpp.unbind_resp", smppHandler);
		jengine.install("smpp.submit_sm", smppHandler);
		jengine.install("smpp.submit_sm_resp", smppHandler);
		jengine.install("smpp.deliver_sm", smppHandler);
		jengine.install("smpp.deliver_sm_resp", smppHandler);
		jengine.install("smpp.bind_receiver", smppHandler);
		jengine.install("smpp.bind_receiver_resp", smppHandler);
		jengine.install("smpp.bind_transceiver_resp", smppHandler);
		jengine.install("smpp.bind_transceiver", smppHandler);
		jengine.install("smpp.bind_transmitter", smppHandler);
		jengine.install("smpp.bind_transmitter_resp", smppHandler);
		jengine.install("smpp.generic_nack", smppHandler);
		jengine.install("jengine.command", commandHandler);
		jengine.install("jengine.status", commandHandler);
	} catch (err) {
		jengine.error(err);
		process.exit(1);
	}
}

main().catch(console.error);
