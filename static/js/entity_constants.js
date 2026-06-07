/** Shared entity UI constants (Smart Home + integration device modal). */

export const CONTROLLABLE = [
    'light', 'switch', 'script', 'input_boolean', 'cover', 'lock', 'vacuum',
    'media_player', 'climate', 'fan', 'humidifier', 'water_heater',
];

export const ACTIVE_STATES = ['on', 'home', 'open', 'unlocked', 'playing', 'cleaning', 'streaming'];

export const STATE_LABELS_RO = {
    on: 'Pornit', off: 'Oprit', home: 'Acasă', not_home: 'Plecat',
    open: 'Deschis', closed: 'Închis', locked: 'Încuiat', unlocked: 'Descuiat',
    playing: 'Redare', paused: 'Pauză', idle: 'Inactiv', standby: 'Standby',
    cleaning: 'Curăță', docked: 'Andocat', returning: 'Se întoarce',
    unavailable: 'Indisponibil', unknown: 'Necunoscut', offline: 'Deconectat',
    available: 'Disponibil', online: 'Conectat', above_horizon: 'Deasupra orizontului',
    below_horizon: 'Sub orizont', sunny: 'Însorit', cloudy: 'Înnorat',
    rainy: 'Ploios', snowy: 'Ninsoare', windy: 'Vânt',
    streaming: 'Live',
};
