// Optional cryptographic signature (PKCS#7 detached, "adbe.pkcs7.detached").
// Runs entirely in the page: the certificate and its key never leave the device.
import forge from "node-forge/lib/forge";
import "node-forge/lib/pkcs12";
import "node-forge/lib/pkcs7";
import { PDFDocument, PDFName, PDFString, PDFHexString, PDFNumber, PDFArray, PDFDict } from "pdf-lib";

const SIZE = 16384; // bytes reserved for the signature (room for a long chain)
const BR = [1000000001, 1000000002, 1000000003]; // ByteRange placeholders, replaced after layout

const oid = forge.pki.oids;
const toBinary = (u8) => {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return s;
};
const attr = (cert, field) => cert.subject.getField(field)?.value || "";

/** Reads a .p12/.pfx. Throws a short, user-readable message on failure. */
export function readCertificate(bytes, password) {
  let p12;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(toBinary(bytes)), password);
  } catch (err) {
    const msg = String(err?.message || err);
    if (/MAC|password|decrypt/i.test(msg)) throw new Error("Wrong password.");
    throw new Error("This isn't a certificate file Paraphe can read.");
  }
  const keys = [
    ...(p12.getBags({ bagType: oid.pkcs8ShroudedKeyBag })[oid.pkcs8ShroudedKeyBag] || []),
    ...(p12.getBags({ bagType: oid.keyBag })[oid.keyBag] || []),
  ];
  const key = keys.map((b) => b.key).find(Boolean);
  const certs = (p12.getBags({ bagType: oid.certBag })[oid.certBag] || []).map((b) => b.cert).filter(Boolean);
  if (!key?.n) throw new Error("Only RSA certificates are supported.");
  const cert = certs.find((c) => c.publicKey?.n?.equals?.(key.n));
  if (!cert) throw new Error("The file has no certificate for its key.");
  const now = new Date();
  if (now > cert.validity.notAfter) throw new Error("This certificate has expired.");
  if (now < cert.validity.notBefore) throw new Error("This certificate isn't valid yet.");
  const selfSigned = cert.isIssuer(cert);
  return {
    key,
    cert,
    chain: certs.filter((c) => c !== cert),
    name: attr(cert, "CN") || attr(cert, "O") || "your certificate",
    issuer: cert.issuer.getField("CN")?.value || "",
    until: cert.validity.notAfter,
    selfSigned,
  };
}

const latin1 = (u8) => new TextDecoder("latin1").decode(u8);

/** The PDF with an empty signature field added (and nothing else changed). */
async function withPlaceholder(bytes, name) {
  let pdf;
  try {
    pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch {
    throw new Error("Can't sign this PDF (it may be password-protected).");
  }
  const ctx = pdf.context;
  const sig = ctx.register(
    ctx.obj({
      Type: "Sig",
      Filter: "Adobe.PPKLite",
      SubFilter: "adbe.pkcs7.detached",
      ByteRange: [0, ...BR],
      Contents: PDFHexString.of("0".repeat(SIZE * 2)),
      M: PDFString.fromDate(new Date()),
      Name: PDFHexString.fromText(name),
      Reason: PDFHexString.fromText("Signed with Paraphe"),
    }),
  );
  const page = pdf.getPages()[0];
  const widget = ctx.register(
    ctx.obj({
      Type: "Annot",
      Subtype: "Widget",
      FT: "Sig",
      T: PDFString.of(`Paraphe signature ${Date.now()}`),
      V: sig,
      F: 132,
      Rect: [0, 0, 0, 0],
      P: page.ref,
    }),
  );
  page.node.addAnnot(widget);
  const catalog = pdf.catalog;
  let form = catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
  if (!form) {
    form = ctx.obj({});
    catalog.set(PDFName.of("AcroForm"), ctx.register(form));
  }
  let fields = form.lookupMaybe(PDFName.of("Fields"), PDFArray);
  if (!fields) {
    fields = ctx.obj([]);
    form.set(PDFName.of("Fields"), fields);
  }
  fields.push(widget);
  form.set(PDFName.of("SigFlags"), PDFNumber.of(3));
  return pdf.save({ useObjectStreams: false });
}

/** Signs the PDF. Must be the very last step: any later change breaks the signature. */
export async function signPdf(bytes, { key, cert, chain, name }) {
  const out = await withPlaceholder(bytes, name);

  // Find the reserved spots, near the end of the file.
  const from = Math.max(0, out.length - 1_500_000);
  const tail = latin1(out.subarray(from));
  const brRe = new RegExp(`/ByteRange\\s*\\[\\s*0\\s+${BR[0]}\\s+${BR[1]}\\s+${BR[2]}\\s*\\]`);
  const br = brRe.exec(tail);
  const ct = new RegExp(`/Contents\\s*<0{${SIZE * 2}}>`).exec(tail);
  if (!br || !ct) throw new Error("Couldn't prepare the signature.");
  const start = from + ct.index + ct[0].indexOf("<");
  const end = from + ct.index + ct[0].length; // just after ">"
  const range = [0, start, end, out.length - end];

  const text = `/ByteRange [${range.join(" ")}]`.padEnd(br[0].length, " ");
  if (text.length !== br[0].length) throw new Error("Couldn't prepare the signature.");
  out.set(new TextEncoder().encode(text), from + br.index);

  const signed = new Uint8Array(range[1] + range[3]);
  signed.set(out.subarray(0, range[1]), 0);
  signed.set(out.subarray(end), range[1]);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(toBinary(signed));
  p7.addCertificate(cert);
  for (const c of chain) p7.addCertificate(c);
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: oid.sha256,
    authenticatedAttributes: [
      { type: oid.contentType, value: oid.data },
      { type: oid.messageDigest },
      { type: oid.signingTime, value: new Date() },
    ],
  });
  p7.sign({ detached: true });
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  if (der.length > SIZE) throw new Error("The certificate chain is too long to sign with.");

  const hex = Array.from(der, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("").padEnd(SIZE * 2, "0");
  out.set(new TextEncoder().encode(hex), start + 1);
  return out;
}
