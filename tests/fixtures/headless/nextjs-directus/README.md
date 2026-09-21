Frontend: next
Backend: directus
Transport: rest
Seeded exposure: client bundle leaks NEXT_PUBLIC_DIRECTUS_ADMIN_TOKEN
Expected detections: NEXT_PUBLIC admin-token exposure (generic D3) + directus-specific admin-token rule (D4)
