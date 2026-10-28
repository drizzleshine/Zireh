# Payment watcher for real Zcash top-ups: ZecCheckout (github.com/samizdatproject/zeccheckout, MIT).
# It holds only a viewing key, so it can see payments to the relay but never spend them.
# Needs ZC_UFVK (uviewtest1… on testnet) and ZC_API_KEY (24+ chars, same as the relay's
# ZECCHECKOUT_API_KEY), both set as secrets on the platform, never in this file.
# The upstream image has no release tags yet; pin a digest here once one is verified.
FROM ghcr.io/samizdatproject/zeccheckout:latest
# Its invoice ↔ address records must survive restarts, or payments to old quotes go unseen.
ENV ZC_NETWORK=testnet ZC_BIND=0.0.0.0:8080 ZC_DB=/data/zeccheckout.db
EXPOSE 8080
