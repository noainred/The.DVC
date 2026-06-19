/**
 * Offline geocoder — maps a city or country name to [lat, lon] using a built-in
 * table, so vCenters get plotted on the map without entering coordinates and
 * without any internet access (works air-gapped). City match wins; otherwise a
 * country centroid is used.
 */

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Major data-center / business cities (incl. Korean sites). [lat, lon]
const CITIES = {
  // Korea
  seoul: [37.57, 126.98], incheon: [37.46, 126.71], daejeon: [36.35, 127.38],
  busan: [35.18, 129.08], daegu: [35.87, 128.60], gwangju: [35.16, 126.85],
  ulsan: [35.54, 129.31], cheongju: [36.64, 127.49], ochang: [36.72, 127.43],
  paju: [37.76, 126.78], pyeongtaek: [36.99, 127.11], suwon: [37.26, 127.03],
  ansan: [37.32, 126.83], gumi: [36.12, 128.34], pohang: [36.02, 129.34],
  asan: [36.79, 127.00], yongin: [37.24, 127.18],
  // APAC
  tokyo: [35.68, 139.69], osaka: [34.69, 135.50], nagoya: [35.18, 136.91],
  singapore: [1.35, 103.82], mumbai: [19.08, 72.88], delhi: [28.61, 77.21],
  bangalore: [12.97, 77.59], bengaluru: [12.97, 77.59], chennai: [13.08, 80.27],
  hyderabad: [17.39, 78.49], pune: [18.52, 73.86], 'hong kong': [22.32, 114.17],
  hongkong: [22.32, 114.17], shanghai: [31.23, 121.47], beijing: [39.90, 116.41],
  shenzhen: [22.54, 114.06], guangzhou: [23.13, 113.26], taipei: [25.03, 121.57],
  sydney: [-33.87, 151.21], melbourne: [-37.81, 144.96], jakarta: [-6.21, 106.85],
  bangkok: [13.76, 100.50], hanoi: [21.03, 105.85], 'ho chi minh': [10.82, 106.63],
  manila: [14.60, 120.98], 'kuala lumpur': [3.14, 101.69],
  // EMEA
  frankfurt: [50.11, 8.68], london: [51.51, -0.13], dublin: [53.35, -6.26],
  amsterdam: [52.37, 4.90], paris: [48.86, 2.35], madrid: [40.42, -3.70],
  milan: [45.46, 9.19], munich: [48.14, 11.58], berlin: [52.52, 13.40],
  warsaw: [52.23, 21.01], stockholm: [59.33, 18.06], oslo: [59.91, 10.75],
  zurich: [47.38, 8.54], vienna: [48.21, 16.37], dubai: [25.20, 55.27],
  'abu dhabi': [24.45, 54.38], riyadh: [24.71, 46.68], istanbul: [41.01, 28.98],
  'tel aviv': [32.08, 34.78], johannesburg: [-26.20, 28.04], cairo: [30.04, 31.24],
  // Americas
  ashburn: [39.04, -77.49], 'san jose': [37.33, -121.89], 'new york': [40.71, -74.01],
  dallas: [32.78, -96.80], chicago: [41.88, -87.63], 'los angeles': [34.05, -118.24],
  seattle: [47.61, -122.33], atlanta: [33.75, -84.39], denver: [39.74, -104.99],
  miami: [25.76, -80.19], 'san francisco': [37.77, -122.42], phoenix: [33.45, -112.07],
  toronto: [43.65, -79.38], montreal: [45.50, -73.57], vancouver: [49.28, -123.12],
  'sao paulo': [-23.55, -46.63], 'são paulo': [-23.55, -46.63], santiago: [-33.45, -70.67],
  'mexico city': [19.43, -99.13], 'buenos aires': [-34.60, -58.38], lima: [-12.05, -77.04],
};

// Country centroids (fallback when the city is unknown). [lat, lon]
const COUNTRIES = {
  korea: [36.5, 127.85], 'south korea': [36.5, 127.85], 'republic of korea': [36.5, 127.85],
  usa: [39.5, -98.35], us: [39.5, -98.35], 'united states': [39.5, -98.35],
  japan: [36.2, 138.25], china: [35.0, 103.0], india: [22.0, 79.0], singapore: [1.35, 103.82],
  germany: [51.0, 10.0], uk: [54.0, -2.0], 'united kingdom': [54.0, -2.0], ireland: [53.0, -8.0],
  netherlands: [52.1, 5.3], france: [46.0, 2.0], spain: [40.0, -4.0], italy: [42.8, 12.8],
  poland: [52.0, 19.0], sweden: [62.0, 15.0], norway: [62.0, 10.0], switzerland: [46.8, 8.2],
  austria: [47.6, 14.1], uae: [24.0, 54.0], 'united arab emirates': [24.0, 54.0],
  'saudi arabia': [24.0, 45.0], turkey: [39.0, 35.0], israel: [31.4, 35.0],
  'south africa': [-29.0, 24.0], egypt: [26.8, 30.8], australia: [-25.0, 133.0],
  brazil: [-10.0, -55.0], canada: [56.0, -106.0], mexico: [23.0, -102.0],
  indonesia: [-2.0, 118.0], thailand: [15.0, 101.0], vietnam: [16.0, 108.0],
  taiwan: [23.7, 121.0], 'hong kong': [22.3, 114.2], philippines: [13.0, 122.0],
  malaysia: [4.2, 101.9], chile: [-33.0, -71.0], argentina: [-34.0, -64.0], peru: [-10.0, -76.0],
};

/** Resolve {lat, lon, match} from a city/country, or null. */
export function geocode(city, country) {
  const c = norm(city);
  if (c && CITIES[c]) return { lat: CITIES[c][0], lon: CITIES[c][1], match: 'city' };
  const co = norm(country);
  if (co && COUNTRIES[co]) return { lat: COUNTRIES[co][0], lon: COUNTRIES[co][1], match: 'country' };
  return null;
}
