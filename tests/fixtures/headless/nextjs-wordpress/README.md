Frontend: next
Backend: wordpress
Transport: graphql
Seeded exposure: client bundle leaks NEXT_PUBLIC_WP_ADMIN_TOKEN
Expected detections: NEXT_PUBLIC admin-token exposure (generic D3) + wordpress-specific admin-token rule (D4)
