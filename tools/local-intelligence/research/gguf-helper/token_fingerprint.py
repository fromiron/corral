"""Non-cryptographic native-input parity fingerprint; never stores token IDs."""


def input_token_fingerprint(token_ids):
    value = 14695981039346656037
    for token in token_ids:
        for byte in int(token).to_bytes(4, byteorder='little', signed=False):
            value = ((value ^ byte) * 1099511628211) & 0xffffffffffffffff
    return f'{value:016x}'
