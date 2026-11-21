// The city's current weather (GET /api/weather), refreshed while the app is open. Nothing about the rider is sent:
// the Worker asks Open-Meteo for the city's center.
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { CACHE_TTL_MS } from '../config'
import type { Weather } from '../weather/openMeteo'

export function useWeather(systemId: string | null): Weather | undefined {
  const q = useQuery({
    queryKey: ['weather', systemId],
    queryFn: ({ signal }) => api.weather(systemId!, signal),
    enabled: !!systemId,
    staleTime: CACHE_TTL_MS.weather,
    refetchInterval: CACHE_TTL_MS.weather,
    retry: false,
  })
  return q.data
}
