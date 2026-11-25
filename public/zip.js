// Minimal ZIP writer (store, no compression). Images are already compressed,
// so deflating them again would only cost time. Exposes window.makeZip.
(function () {
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  /** @param {{name: string, blob: Blob}[]} entries */
  async function makeZip(entries) {
    const encoder = new TextEncoder();
    const { time, date } = dosDateTime(new Date());
    const UTF8_FLAG = 0x0800;
    const fileParts = [];
    const centralParts = [];
    let offset = 0;

    for (const { name, blob } of entries) {
      const data = new Uint8Array(await blob.arrayBuffer());
      const nameBytes = encoder.encode(name);
      const crc = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, UTF8_FLAG, true);
      local.setUint16(8, 0, true); // method: store
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);
      fileParts.push(local, nameBytes, data);

      const central = new DataView(new ArrayBuffer(46));
      central.setUint32(0, 0x02014b50, true);
      central.setUint16(4, 20, true);
      central.setUint16(6, 20, true);
      central.setUint16(8, UTF8_FLAG, true);
      central.setUint16(10, 0, true);
      central.setUint16(12, time, true);
      central.setUint16(14, date, true);
      central.setUint32(16, crc, true);
      central.setUint32(20, data.length, true);
      central.setUint32(24, data.length, true);
      central.setUint16(28, nameBytes.length, true);
      central.setUint32(42, offset, true);
      centralParts.push(central, nameBytes);

      offset += 30 + nameBytes.length + data.length;
    }

    const centralSize = centralParts.reduce((sum, p) => sum + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...fileParts, ...centralParts, end], { type: 'application/zip' });
  }

  window.makeZip = makeZip;
})();
