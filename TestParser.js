const RESPParser = require("./RESPParser");
const parser = new RESPParser();

const input =
  "*1\r\n$4\r\nPING\r\n" +
  "*2\r\n$3\r\nGET\r\n$3\r\nkey\r\n";

console.log(parser.push(input));