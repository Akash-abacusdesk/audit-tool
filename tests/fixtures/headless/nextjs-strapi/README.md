Frontend: next
Backend: strapi
Transport: rest
Seeded exposure: client bundle leaks NEXT_PUBLIC_STRAPI_API_TOKEN
Expected detections: NEXT_PUBLIC admin-token exposure (generic D3) + strapi-specific admin-token rule (D4)
