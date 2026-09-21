ARG WP_DIGEST=
FROM docker.io/library/wordpress:6.6-apache${WP_DIGEST}

LABEL org.opencontainers.image.title="devsecops/cms-wordpress" \
      org.opencontainers.image.version="fixture" \
      org.opencontainers.image.base="docker.io/library/wordpress:6.6-apache"

# Fixture ships its WordPress content tree; core is provided by the base image.
COPY wp-content /var/www/html/wp-content

EXPOSE 8080

CMD ["apache2-foreground"]
