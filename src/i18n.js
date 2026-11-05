// -----------------------------------------------------------------------------
// Runtime texts (English and French): device and feature names, the status of
// the integration, the answers of the buttons and the command errors. Never a
// value typed by the user (an address typed wrong is shown by its length) nor
// anything received from the charger but short checked values (serial number,
// model, numbers).
// -----------------------------------------------------------------------------

import { ROLE as R } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** Two texts one after the other, in both languages. */
export const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) return both(`${seconds} s`, `${seconds} s`);
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return both(`${minutes} min`, `${minutes} min`);
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const DEVICE_NAME = both('MENNEKES AMTRON', 'MENNEKES AMTRON');

export const FEATURE_NAMES = {
  [R.STATUS]: both('Charge point status', 'État de la borne'),
  [R.CONNECTOR]: both('Connector', 'Connecteur'),
  [R.CHARGING_STATE]: both('Charging state', 'État de la charge'),
  [R.PLUGGED]: both('Vehicle plugged in', 'Véhicule branché'),
  [R.ERROR]: both('Error', 'Erreur'),
  [R.PAUSED]: both('Paused by the limit', 'En pause par la limite'),
  [R.POWER]: both('Charging power', 'Puissance de charge'),
  [R.CURRENT_L1]: both('Current L1', 'Courant L1'),
  [R.CURRENT_L2]: both('Current L2', 'Courant L2'),
  [R.CURRENT_L3]: both('Current L3', 'Courant L3'),
  [R.VOLTAGE_L1]: both('Voltage L1', 'Tension L1'),
  [R.VOLTAGE_L2]: both('Voltage L2', 'Tension L2'),
  [R.VOLTAGE_L3]: both('Voltage L3', 'Tension L3'),
  [R.ENERGY_INDEX]: both('Energy meter', 'Compteur d’énergie'),
  [R.SESSION_ENERGY]: both('Energy of the session', 'Énergie de la session'),
  [R.SESSION_DURATION]: both('Duration of the session', 'Durée de la session'),
  [R.SIGNALED_CURRENT]: both('Current offered to the vehicle', 'Courant proposé au véhicule'),
  [R.CURRENT_LIMIT]: both('Current limit set (HEMS)', 'Limite de courant réglée (HEMS)'),
  [R.PAUSE]: both('Pause charging', 'Mettre la charge en pause'),
  [R.RESUME]: both('Resume charging', 'Reprendre la charge'),
  [R.SET_CURRENT]: both('Charging current', 'Courant de charge'),
};

const kwh = (value) => `${Math.round(value * 1000) / 1000} kWh`;

export const T = {
  noHost: both(
    'Enter the IP address of the AMTRON charger in the configuration.',
    'Saisissez l’adresse IP de la borne AMTRON dans la configuration.',
  ),
  invalid: (length) =>
    both(
      `The address typed (${length} characters) is not a valid IPv4 address or host name.`,
      `L’adresse saisie (${length} caractères) n’est pas une adresse IPv4 ou un nom d’hôte valide.`,
    ),
  configUnreadable: both(
    'The configuration could not be read from Gladys: tried again every 30 s.',
    'La configuration n’a pas pu être lue depuis Gladys : nouvel essai toutes les 30 s.',
  ),
  connecting: both('Connecting to the charger…', 'Connexion à la borne…'),
  waiting: (wait) =>
    both(
      `Next read of the charger in ${wait.en}.`,
      `Prochaine lecture de la borne dans ${wait.fr}.`,
    ),
  lastRead: (ago) => both(`Last read ${ago.en} ago.`, `Dernière lecture il y a ${ago.fr}.`),
  unreachable: (address, wait) =>
    both(
      `The charger does not answer on Modbus TCP at ${address} (Modbus TCP server enabled? another Modbus client connected?). Next try in ${wait.en}.`,
      `La borne ne répond pas en Modbus TCP à l’adresse ${address} (serveur Modbus TCP activé ? autre client Modbus connecté ?). Nouvel essai dans ${wait.fr}.`,
    ),
  failing: (reason, wait) =>
    both(
      `Reading the charger failed (${reason}). Next try in ${wait.en}.`,
      `La lecture de la borne a échoué (${reason}). Nouvel essai dans ${wait.fr}.`,
    ),
  notAmtron: both(
    'The device at this address does not say it is an AMTRON (register 141 is not "AM"): nothing is published nor sent but a pause.',
    'L’appareil à cette adresse ne se présente pas comme une AMTRON (le registre 141 ne vaut pas « AM ») : rien n’est publié ni envoyé, sauf une pause.',
  ),
  badApiPort: both(
    'The port of the web interface must be a whole number from 1 to 65535: the serial number of the charger cannot be read.',
    'Le port de l’interface web doit être un nombre entier de 1 à 65535 : le numéro de série de la borne ne peut pas être lu.',
  ),
  identifying: both(
    'Connected over Modbus; reading the serial number of the charger on its web interface…',
    'Connecté en Modbus ; lecture du numéro de série de la borne sur son interface web…',
  ),
  noSerial: (host, port, reason) =>
    both(
      `Connected over Modbus, but the serial number could not be read at http://${host}:${port}/api/v1/PublicInfo (${reason}): the device is published once it is read (tried again at every read).`,
      `Connecté en Modbus, mais le numéro de série n’a pas pu être lu sur http://${host}:${port}/api/v1/PublicInfo (${reason}) : l’appareil est publié dès qu’il est lu (nouvel essai à chaque lecture).`,
    ),
  connected: (serial, v) => {
    const parts = [];
    if (v[R.STATUS]) parts.push(v[R.STATUS]);
    if (v[R.POWER] !== undefined) parts.push(`${v[R.POWER]} W`);
    const limitEn = v.hemsLimit === undefined ? '' : `, limit ${v.hemsLimit} A`;
    const limitFr = v.hemsLimit === undefined ? '' : `, limite ${v.hemsLimit} A`;
    const model = v.model ? ` (${v.model})` : '';
    return both(
      `Connected to the AMTRON ${serial}${model}: ${parts.join(', ') || 'no state read'}${limitEn}.`,
      `Connecté à l’AMTRON ${serial}${model} : ${parts.join(', ') || 'aucun état lu'}${limitFr}.`,
    );
  },
  missingBlocks: (list) => both(`Not read this time: ${list}.`, `Non lu cette fois : ${list}.`),
  keepAlive: (seconds) =>
    both(
      `Read every ${seconds} s while the limit set is below the Safe Current.`,
      `Lue toutes les ${seconds} s tant que la limite réglée est sous le Safe Current.`,
    ),
  hemsReadOnly: both(
    'The Modbus TCP server of the charger is not in "HEMS read and write" mode (register 2010): pause and commands are refused by the charger until it is set in its installer menu.',
    'Le serveur Modbus TCP de la borne n’est pas en mode « HEMS lecture et écriture » (registre 2010) : la pause et les commandes sont refusées par la borne tant que ce mode n’est pas réglé dans son menu installateur.',
  ),
  safeCurrent: (seconds, amps) =>
    both(
      `Paused: if Gladys stops reading the charger for ${seconds} s, the charger charges again at its Safe Current (${amps} A, installer menu; 0 A keeps the pause).`,
      `En pause : si Gladys ne lit plus la borne pendant ${seconds} s, la borne recharge à son Safe Current (${amps} A, menu installateur ; 0 A garde la pause).`,
    ),
  stopHeld: (since) =>
    both(
      `A pause is not seen applied yet (for ${since.en}): checked and written again every 15 s.`,
      `Une pause n’est pas encore vue appliquée (depuis ${since.fr}) : vérifiée et réécrite toutes les 15 s.`,
    ),
  indexHeld: (held) =>
    both(
      `The energy meter ${held.direction === 'down' ? 'dropped' : 'jumped'} from ${kwh(held.from)} to ${kwh(held.to)}: held back, "Accept the held index" takes it.`,
      `Le compteur d’énergie a ${held.direction === 'down' ? 'baissé' : 'sauté'} de ${kwh(held.from)} à ${kwh(held.to)} : retenu, « Accepter l’index retenu » le prend.`,
    ),
  accept: {
    nothing: both('No index is held back.', 'Aucun index n’est retenu.'),
    confirm: (held) => {
      const list = held.map((h) => `${kwh(h.from)} → ${kwh(h.to)}`).join(', ');
      return both(
        `Held back: ${list}. Click again within 5 minutes (after 3 s) to accept it.`,
        `Retenu : ${list}. Cliquez à nouveau dans les 5 minutes (après 3 s) pour l’accepter.`,
      );
    },
    done: (accepted, skipped) =>
      accepted.length > 0
        ? both('Index accepted.', 'Index accepté.')
        : both(
            `Not accepted: the value held changed since the first click (${skipped.length}).`,
            `Non accepté : la valeur retenue a changé depuis le premier clic (${skipped.length}).`,
          ),
  },
};

export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonction est en lecture seule.'),
  noHost: T.noHost,
  badValue: both('Unexpected value.', 'Valeur inattendue.'),
  badNumber: both(
    'The current must be a whole number of amperes.',
    'Le courant doit être un nombre entier d’ampères.',
  ),
  outOfBounds: (min, max) =>
    both(
      `The charging current must be from ${min} A to ${max} A.`,
      `Le courant de charge doit être compris entre ${min} A et ${max} A.`,
    ),
  disabled: both(
    'Resuming the charge and setting the current are disabled: enable "Allow resume and current" in the configuration.',
    'La reprise de la charge et le réglage du courant sont désactivés : activez « Autoriser la reprise et le courant » dans la configuration.',
  ),
  stopRunning: both(
    'A pause is being sent: try again in a few seconds.',
    'Une pause est en cours d’envoi : réessayez dans quelques secondes.',
  ),
  busy: both('Too many commands waiting.', 'Trop de commandes en attente.'),
  queued: both(
    'Still waiting for its turn on the charger: it goes within 15 s or not at all.',
    'Toujours en attente de son tour sur la borne : part dans les 15 s ou pas du tout.',
  ),
  sentUnconfirmed: (reason) =>
    both(
      `Sent, without confirmation (${reason}): the next reads will show it.`,
      `Envoyée, sans confirmation (${reason}) : les prochaines lectures le montreront.`,
    ),
  noAnswerYet: both('no answer yet', 'pas encore de réponse'),
  tooSlow: both(
    'The charger answered too slowly: nothing sent.',
    'La borne a répondu trop lentement : rien envoyé.',
  ),
  protectMeanwhile: both(
    'A pause was clicked meanwhile: nothing sent.',
    'Une pause a été demandée entre-temps : rien envoyé.',
  ),
  configChanged: both(
    'The configuration changed meanwhile: nothing sent.',
    'La configuration a changé entre-temps : rien envoyé.',
  ),
  notSent: (reason) => both(`Nothing sent (${reason}).`, `Rien envoyé (${reason}).`),
  refused: (reason) =>
    both(`Refused by the charger (${reason}).`, `Refusée par la borne (${reason}).`),
  unknownState: (reason) =>
    both(
      `The state of the charger could not be read (${reason}): nothing sent.`,
      `L’état de la borne n’a pas pu être lu (${reason}) : rien envoyé.`,
    ),
  unknownIdentity: both(
    'The serial number of the charger could not be read (web interface): nothing sent.',
    'Le numéro de série de la borne n’a pas pu être lu (interface web) : rien envoyé.',
  ),
  otherDevice: both(
    'Another charger answers at this address: nothing sent.',
    'Une autre borne répond à cette adresse : rien envoyé.',
  ),
  unknownValue: both(
    'A value needed to decide could not be read: nothing sent.',
    'Une valeur nécessaire n’a pas pu être lue : rien envoyé.',
  ),
  readOnlyMode: both(
    'The Modbus TCP server of the charger is not in "HEMS read and write" mode (installer menu): nothing sent.',
    'Le serveur Modbus TCP de la borne n’est pas en mode « HEMS lecture et écriture » (menu installateur) : rien envoyé.',
  ),
  noResumeValue: both(
    'No charging current was read before the pause: choose one with "Charging current".',
    'Aucun courant de charge n’a été lu avant la pause : choisissez-en un avec « Courant de charge ».',
  ),
  readBackDiffers: both(
    'the value read back is not the one asked',
    'la valeur relue n’est pas celle demandée',
  ),
  stopPending: both(
    'The pause could not leave yet (charger unreachable): kept and tried again every 15 s.',
    'La pause n’a pas encore pu partir (borne injoignable) : gardée et réessayée toutes les 15 s.',
  ),
  stopRefused: (reason) =>
    both(
      `The charger refused the pause (${reason}): its Modbus TCP server must be in "HEMS read and write" mode; tried again every 15 s.`,
      `La borne a refusé la pause (${reason}) : son serveur Modbus TCP doit être en mode « HEMS lecture et écriture » ; réessayée toutes les 15 s.`,
    ),
};
