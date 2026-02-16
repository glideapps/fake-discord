import { describe, it, expect } from "vitest";
import * as ed from "@noble/ed25519";
import {
  hexToBytes,
  bytesToHex,
  getPrivateKeyBytes,
  getPublicKey,
  signPayload,
  verifySignature,
} from "../helpers.js";

describe("hexToBytes / bytesToHex", () => {
  it("roundtrips correctly", () => {
    const original = new Uint8Array([0, 1, 127, 128, 255]);
    const hex = bytesToHex(original);
    expect(hex).toBe("00017f80ff");
    const back = hexToBytes(hex);
    expect(back).toEqual(original);
  });

  it("handles empty input", () => {
    expect(bytesToHex(new Uint8Array([]))).toBe("");
    expect(hexToBytes("")).toEqual(new Uint8Array([]));
  });

  it("handles known vector", () => {
    expect(hexToBytes("deadbeef")).toEqual(
      new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    );
  });
});

describe("getPrivateKeyBytes", () => {
  it("returns 32-byte seed from 64 hex chars", () => {
    const seed = new Uint8Array(32);
    seed[0] = 42;
    const seedHex = bytesToHex(seed);
    expect(seedHex.length).toBe(64);

    const result = getPrivateKeyBytes(seedHex);
    expect(result.length).toBe(32);
    expect(result[0]).toBe(42);
  });

  it("extracts seed from 128 hex chars (64-byte key)", () => {
    const fullKey = new Uint8Array(64);
    fullKey[0] = 99;
    const fullKeyHex = bytesToHex(fullKey);
    expect(fullKeyHex.length).toBe(128);

    const result = getPrivateKeyBytes(fullKeyHex);
    expect(result.length).toBe(32);
    expect(result[0]).toBe(99);
  });
});

describe("getPublicKey", () => {
  it("derives public key from seed", async () => {
    const seed = new Uint8Array(32);
    seed[0] = 7;
    const seedHex = bytesToHex(seed);

    const pubKey = await getPublicKey(seedHex);
    expect(pubKey.length).toBe(32);

    // Verify it matches @noble/ed25519 directly
    const expected = await ed.getPublicKeyAsync(seed);
    expect(bytesToHex(pubKey)).toBe(bytesToHex(expected));
  });
});

describe("signPayload", () => {
  it("produces a valid Ed25519 signature", async () => {
    const seed = new Uint8Array(32);
    seed[0] = 7;
    const seedHex = bytesToHex(seed);
    const pubKey = await ed.getPublicKeyAsync(seed);

    const timestamp = "1700000000";
    const body = '{"type":1}';
    const sigHex = await signPayload(seedHex, timestamp, body);

    const sig = hexToBytes(sigHex);
    const message = new TextEncoder().encode(timestamp + body);
    expect(await ed.verifyAsync(sig, message, pubKey)).toBe(true);
  });
});
