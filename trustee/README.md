# Mongbas threshold trustee

This package implements the offline custody layer for a 2-of-3 Feldman DKG.
Each organization owns an X25519 transport key and an Ed25519 contribution
signing key. Every dealer creates a random degree-one polynomial, publishes
Feldman commitments, and encrypts one evaluation to each trustee. A trustee
decrypts only its addressed envelopes, verifies every evaluation against the
commitments, and stores only its aggregate scalar share in a mode-`0600` file.

The public transcript contains the election public key, the three public
trustee shares, commitments, signed-contribution hashes, algorithm/group
parameters, and a canonical transcript hash. It never contains a scalar share
or a complete election private key.

This is the first integration stage. Until chaincode election creation consumes
the public transcript and partial decryptions are produced by these external
trustee processes, the deployed shared-PDC path remains the active path and the
ballot-secrecy custody gate remains failed.

Run `npm test` in this directory for threshold reconstruction, authentication,
wrong-recipient, mutation, missing-dealer, wrong-ceremony and forged-public-share
tests. The CLI refuses to read private records that are not mode `0600` and
refuses to overwrite any output.
