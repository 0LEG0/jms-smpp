module.exports = {
    listener: {
        default: {
            enabled: true,
            host: "127.0.0.1",
            port: 2775,
            family: 4
        },
        custom_3456: {
            enabled: false,
            host: "127.0.0.1",
            port: 3456,
            family: 4
        }
    },
    connection: {
        test: {
            enabled: false,
            // localAddress: "127.0.0.1",
            host: "127.0.0.1",
            port: 2777,
            family: 4,
            // type: "transmitter",
            system_id: "demouser",
            password: "demo0pass",
            restart: 5000
        }
    },
    tlv: {
        mccmnc: {
            id: 0x1416,
            type: "int32"
        }
    }
}