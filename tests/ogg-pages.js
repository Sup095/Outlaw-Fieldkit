/* Ogg pages made by hand, for the sound tests. Not a suite itself.
   page(packets, seq, opts): one page holding those packets, each laced
   into 255-byte segments the way Ogg does it. opts.open leaves the last
   packet unfinished (its last segment is a full 255), to be continued
   on the next page. The checksum is left at zero: the relay does not
   check it, since the stream is ffmpeg's own. */
"use strict";

function page(packets, seq, opts) {
  const segs = [];
  packets.forEach((p, k) => {
    let n = p.length;
    while (n >= 255) { segs.push(255); n -= 255; }
    if (!(opts && opts.open && k === packets.length - 1)) segs.push(n);
  });
  const h = Buffer.alloc(27);
  h.write("OggS", 0, "latin1");
  h[5] = opts && opts.continued ? 1 : 0;
  h.writeUInt32LE(seq | 0, 18);
  h[26] = segs.length;
  return Buffer.concat([h, Buffer.from(segs), Buffer.concat(packets)]);
}

module.exports = { page };
