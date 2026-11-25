// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys: the connection status and the answer of the
// "Test" button are { en, fr }; errors thrown to Gladys (commands, buttons)
// are English, like the core's. No text of Channels goes in a status.
// -----------------------------------------------------------------------------

import { CODES } from './channels/http.js';

const plural = (n, one, many) => (n === 1 ? one : many);

/** Why a target failed, in a few words. */
export function reasonOf(err) {
  switch (err?.code) {
    case CODES.REFUSED:
      return { en: 'connection refused', fr: 'connexion refusée' };
    case CODES.UNREACHABLE:
      return { en: 'no connection', fr: 'pas de connexion' };
    case CODES.TIMEOUT:
      return { en: 'no answer in time', fr: 'pas de réponse à temps' };
    case CODES.HTTP:
      return { en: `HTTP error ${err.status}`, fr: `erreur HTTP ${err.status}` };
    case CODES.TOO_LARGE:
      return { en: 'answer too large', fr: 'réponse trop grande' };
    case CODES.BAD_ANSWER:
      return { en: 'unexpected answer', fr: 'réponse inattendue' };
    default:
      return { en: 'error', fr: 'erreur' };
  }
}

const join = (parts) => ({
  en: parts.map((p) => p.en).join(' '),
  fr: parts.map((p) => p.fr).join(' '),
});

export const T = {
  join,
  status: {
    nothing: {
      en: 'Nothing to read: type the address of the Channels DVR Server or of a Channels app.',
      fr: "Rien à lire : saisissez l'adresse du serveur Channels DVR ou d'une application Channels.",
    },
    serverInvalid: {
      en: 'The address of the server is not valid (host or IP, optional port, no path).',
      fr: "L'adresse du serveur n'est pas valide (nom ou IP, port facultatif, sans chemin).",
    },
    serverHttps: {
      en: 'Use the local http address of the server (http://IP:8089): https is not supported.',
      fr: "Utilisez l'adresse http locale du serveur (http://IP:8089) : https n'est pas pris en charge.",
    },
    invalidPlayers: (n) => ({
      en: `${n} player ${plural(n, 'entry', 'entries')} ignored (invalid, duplicate or beyond 10).`,
      fr: `${n} ${plural(n, 'lecteur ignoré', 'lecteurs ignorés')} (invalide, en double ou au-delà de 10).`,
    }),
    dataUnreadable: {
      en: '/data cannot be read: the first readings wait one interval.',
      fr: '/data illisible : les premières lectures attendent un intervalle.',
    },
    waiting: {
      en: 'Waiting for the first reading.',
      fr: 'En attente de la première lecture.',
    },
    server: (jobs) => ({
      en: `Server: ${jobs.recording} recording, ${jobs.upcoming} upcoming.`,
      fr: `Serveur : ${jobs.recording} en cours, ${jobs.upcoming} à venir.`,
    }),
    serverDown: (reason) => ({
      en: `Server not read (${reason.en}).`,
      fr: `Serveur non lu (${reason.fr}).`,
    }),
    players: (answering, total, closed) => ({
      en: `Players answering: ${answering} of ${total}.${closed > 0 ? ` ${closed} refuse the connection (app closed, or a wrong address or port).` : ''}`,
      fr: `Lecteurs qui répondent : ${answering} sur ${total}.${closed > 0 ? ` ${closed} refusent la connexion (application fermée, ou adresse ou port faux).` : ''}`,
    }),
  },
  test: {
    server: (jobs, disk) => ({
      en: `Server: ${jobs.recording} recording, ${jobs.upcoming} upcoming${disk ? `, ${(disk.free / 1e9).toFixed(1)} GB free` : ''}.`,
      fr: `Serveur : ${jobs.recording} en cours, ${jobs.upcoming} à venir${disk ? `, ${(disk.free / 1e9).toFixed(1).replace('.', ',')} Go libres` : ''}.`,
    }),
    serverDown: (reason) => ({
      en: `Server: not read (${reason.en}).`,
      fr: `Serveur : non lu (${reason.fr}).`,
    }),
    player: (name, reading) => {
      if (!reading) return { en: `${name}: not read yet.`, fr: `${name} : pas encore lu.` };
      if (!reading.online) {
        return reading.closed
          ? { en: `${name}: the app is not running.`, fr: `${name} : l'application ne tourne pas.` }
          : {
              en: `${name}: no answer (${reasonOf(reading.error).en}).`,
              fr: `${name} : pas de réponse (${reasonOf(reading.error).fr}).`,
            };
      }
      const state = ['paused', 'playing', 'stopped'][reading.status.playback] ?? 'unknown';
      const etat = ['en pause', 'en lecture', 'arrêtée'][reading.status.playback] ?? 'inconnue';
      return { en: `${name}: playback ${state}.`, fr: `${name} : lecture ${etat}.` };
    },
    age: (seconds) => ({
      en: `(Periodic readings, every ${seconds} s: the button does not read out of turn.)`,
      fr: `(Lectures périodiques, toutes les ${seconds} s : le bouton ne lit pas hors tour.)`,
    }),
  },
  errors: {
    testTooLong: 'The test took too long: see the connection status in a moment',
    readOnly: 'This feature is read only',
    unknownDevice: 'Unknown device of this integration',
    notConfigured: 'This player is no longer in the configuration',
  },
};
