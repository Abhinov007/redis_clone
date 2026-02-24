const net = require("net");

const client = net.createConnection({ port: 6379 }, () => {
  console.log("Connected to server\n");

  sendSET();
});

function sendSET() {
  console.log("Sending: SET a 10");

  const setCmd =
    "*3\r\n" +
    "$3\r\nSET\r\n" +
    "$1\r\na\r\n" +
    "$2\r\n10\r\n";

  client.write(setCmd);
}

function sendGET() {
  console.log("Sending: GET a");

  const getCmd =
    "*2\r\n" +
    "$3\r\nGET\r\n" +
    "$1\r\na\r\n";

  client.write(getCmd);
}

client.on("data", (data) => {
  console.log("Raw Response:");
  console.log(JSON.stringify(data.toString()));
  console.log();

  // After SET response arrives, send GET
  if (data.toString().includes("+OK")) {
    sendGET();
  }
});

client.on("end", () => {
  console.log("Disconnected from server");
});

client.on("error", (err) => {
  console.error("Client error:", err);
});