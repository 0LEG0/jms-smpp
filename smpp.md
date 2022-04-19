# SMPP Messages

## smpp.listen
### handles | listener enqueues => address | error
- listener_id: "listener_id" // required
- host: "127.0.0.1", // listen address
- port: 2775, // listen port
- family: 4, // TCPv4

## smpp.unlisten
### handles | listener enqueues => listener_id | error 
- listener_id: // required

## smpp.connect (incoming)
### listener -> dispatch => accept | close
- direction: "incoming"
- listener_id: server.id
- connection_id: conn.id
- localAddress: conn.socket.localAddress
- localPort: conn.socket.localPort
- remoteAddress: conn.socket.remoteAddress
- remotePort: conn.socket.remotePort

## smpp.connect (outgoing)
### connection -> enqueue (notice) on socket event "connect" 
- direction: "outgoing",
- listener_id: conn.listener_id,
- connection_id: conn.id, // required
- localAddress: conn.socket.localAddress,
- localPort: conn.socket.localPort,
- remoteAddress: conn.socket.remoteAddress,
- remotePort: conn.socket.remotePort,
- handled: true, // notice

## smpp.disconnect
### connection -> enqueue (notice) on socket event "disconnect"
- listener_id: conn.listener_id,
- connection_id: conn.id,
- localAddress: conn.socket.localAddress,
- localPort: conn.socket.localPort,
- remoteAddress: conn.socket.remoteAddress,
- remotePort: conn.socket.remotePort,
- handled: true, // notice

## smpp.error
### connection -> enqueue (notice) on socket event "error"
- listener_id: conn.listener_id,
- connection_id: conn.id,
- localAddress: conn.socket.localAddress,
- localPort: conn.socket.localPort,
- remoteAddress: conn.socket.remoteAddress,
- remotePort: conn.socket.remotePort,
- error: { ...err },
- handled: true, // notice

## PDU:

## smpp.bind_transceiver .bind_transmitter .bind_receiver (incoming)
### connection -> dispatch => status -> enqueue smpp.bind_transceiver_resp: {command_status: status}
- sequence_number: auto
- direction: "incoming",
- listener_id: conn.listener_id,
- connection_id: conn.id,
- command_status: ?,
- system_id: value
- password: value
- ...pdd fields

## smpp.bind_transceiver .bind_transmitter .bind_receiver (outgoing)
### handles by SMPP module
- sequence_number: auto
- direction: "outgoing",
- connection_id: conn.id,
- command_status: undefined, // returns ESM_OK = 0 or error status
- system_id: value
- password: value

## smpp.bind_transceiver_resp .bind_transmitter_resp .bind_receiver_resp
### connection -> enqueue
- sequence_number: pdu.sequence_number,
- command_status: command_status,
- direction: "outgoing" | "incoming",
- listener_id: conn.listener_id,
- connection_id: conn.id

## smpp.submit_sm .deliver_sm (incoming)
### connection -> dispatch => status -> enqueue smpp.submit_sm_resp: {command_status: status}
- direction: "incoming",
- connection_id: conn.id,
- listener_id: conn.listener_id,
- command_status: !conn.bound
	? smpp.ESME_RINVBNDSTS
	: undefined,
- handled: !conn.bound ? true : false, // notification of request

## smpp.submit_sm_resp .deliver_sm_resp
### connection -> enqueue
- sequence_number: pdu.sequence_number,
- command_status: command_status,
- direction: "outgoing" | "incoming",
- listener_id: conn.listener_id,
- connection_id: conn.id
