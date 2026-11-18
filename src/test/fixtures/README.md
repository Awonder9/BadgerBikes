# Test fixtures

Real responses captured on 2026-11-17 from the live services (see `docs/ARCHITECTURE.md` §2).
`_httpStatus` (where present) was added by the capture script and is the HTTP status of the response;
it is not part of the API payload.

Trip used for routing fixtures (see `trip_meta.json`): origin = Wisconsin State Capitol (43.07467, -89.38420),
destination = Memorial Union (43.07652, -89.40030). Pickup candidates are the 4 stations nearest the origin;
dropoff candidates are the 4 nearest the destination (Madison BCycle).

| File | Request |
|---|---|
| `gbfs/madison_*.json` | `https://gbfs.bcycle.com/bcycle_madison/{feed}.json` (GBFS 1.1, booleans as 0/1) |
| `gbfs/madison_v2_station_status.json` | `https://gbfs.bcycle.com/2/bcycle_madison/station_status.json` (GBFS 2.1, booleans as true/false) |
| `valhalla/route_pedestrian.json` | `/route` pedestrian, origin → pickup candidate 0, `units: kilometers` |
| `valhalla/route_bicycle.json` | `/route` bicycle (Hybrid), pickup 0 → dropoff 0, `units: kilometers` |
| `valhalla/route_pedestrian_dest.json` | `/route` pedestrian, dropoff 0 → destination |
| `valhalla/route_far_from_road.json` | `/route` pedestrian from a point in Lake Mendota (Valhalla snaps to the shore — NOT an error) |
| `valhalla/error_no_route.json` | HTTP 400, error_code 154 (path distance exceeds 150 km limit for bicycle) |
| `valhalla/error_no_edges.json` | HTTP 400, error_code 171 (no suitable edges near location — middle of the Pacific) |
| `osrm/route_bike.json` | `routed-bike/route/v1/driving/...?overview=full&geometries=geojson&steps=true` pickup 0 → dropoff 0 |
| `osrm/route_foot.json` | `routed-foot/route/v1/...` origin → pickup 0 |
| `osrm/table_bike.json` | `routed-bike/table/v1/driving/{4 pickups;4 dropoffs}?sources=0;1;2;3&destinations=4;5;6;7&annotations=duration,distance` |
| `osrm/error_no_route.json` | HTTP 400 `{"code":"NoRoute"}` (Madison → Honolulu) |
| `osrm/error_invalid.json` | HTTP 400 `{"code":"InvalidValue"}` (latitude 95) |
| `valhalla/trace_attributes_bicycle.json` | `/trace_attributes` bicycle, `walk_or_snap`, shape + edge length/use/cycle_lane/road_class/mean_elevation/begin+end_shape_index (the route_bicycle shape) |
| `photon/search_memorial_union.json` | `/api/?q=memorial union&lat=43.0747&lon=-89.3842&limit=5&lang=en` |
| `photon/search_partial.json` | `/api/?q=state st&...&bbox=-89.55,42.98,-89.25,43.17` |
| `photon/reverse.json` | `/reverse?lat=43.07467&lon=-89.38420&limit=1&lang=en` |

| `api/geocode_apex_grill.json` | our Worker's `GET /api/geocode?q=apex grill&system=bcycle_madison` (captured from `npm run dev`) |

## Sources and attribution

These are real responses captured from public services, kept small for tests:
- `gbfs/` — BCycle's public GBFS feeds (gbfs.bcycle.com).
- `valhalla/`, `osrm/` — FOSSGIS routing servers; route data © OpenStreetMap contributors (ODbL).
- `photon/` — Photon geocoder by komoot; place data © OpenStreetMap contributors (ODbL).

OpenStreetMap data is available under the Open Database License: https://www.openstreetmap.org/copyright
