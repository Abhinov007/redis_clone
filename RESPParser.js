class RESPParser {
    constructor() {
      this.buffer = "";
    }
  
    push(chunk) {
      this.buffer += chunk;
      const results = [];
  
      while (true) {
        const parsed = this.parseNext();
        if (!parsed) break;
  
        results.push(parsed.value);
        this.buffer = this.buffer.slice(parsed.bytesUsed);
      }
  
      return results;
    }
  
    parseNext() {
      if (this.buffer.length === 0) return null;
  
      const type = this.buffer[0];
  
      if (type === "*") {
        return this.parseArray();
      }
  
      return null;
    }
  
    parseArray() {
      let idx = 1;
  
      const readLine = () => {
        const end = this.buffer.indexOf("\r\n", idx);
        if (end === -1) return null;
        const line = this.buffer.slice(idx, end);
        idx = end + 2;
        return line;
      };
  
      const countLine = readLine();
      if (countLine === null) return null;
  
      const count = parseInt(countLine, 10);
      if (isNaN(count) || count < 0) return null;
  
      const args = [];
  
      for (let i = 0; i < count; i++) {
        if (this.buffer[idx] !== "$") return null;
        idx++;
  
        const lenLine = readLine();
        if (lenLine === null) return null;
  
        const len = parseInt(lenLine, 10);
        if (isNaN(len)) return null;
  
        if (len === -1) {
          args.push(null);
          continue;
        }
  
        if (this.buffer.length < idx + len + 2) {
          return null;
        }
  
        const value = this.buffer.slice(idx, idx + len);
        idx += len + 2;
  
        args.push(value);
      }
  
      return {
        value: args,
        bytesUsed: idx
      };
    }
  }
  
  module.exports = RESPParser;