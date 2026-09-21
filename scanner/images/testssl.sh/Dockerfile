FROM docker.io/drwetter/testssl.sh@sha256:77422209ba0f38bac0c50bebd35961cca57a3ba0b9de9b664ca262936ff88817

LABEL org.opencontainers.image.title="devsecops/scanner-testssl" \
      org.opencontainers.image.version="3.2" \
      org.opencontainers.image.base="docker.io/drwetter/testssl.sh:3.2" \
      org.opencontainers.image.base.digest="sha256:77422209ba0f38bac0c50bebd35961cca57a3ba0b9de9b664ca262936ff88817"

ENV HOME=/tmp

WORKDIR /tmp

USER 10001

ENTRYPOINT ["testssl.sh"]
CMD ["--version"]
