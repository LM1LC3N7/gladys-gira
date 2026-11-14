// -----------------------------------------------------------------------------
// The texts users read (status, action results, refusals, feature names), in
// English and French. A text never quotes a token, a password nor anything
// typed by the user that was refused.
// -----------------------------------------------------------------------------

/** The text of a message in a language. */
export const word = (text, language) =>
  typeof text === 'string' ? text : (text?.[language] ?? text?.en ?? '');

const both = (en, fr) => ({ en, fr });

const NAMES = {
  on: both('On', 'Allumé'),
  brightness: both('Brightness', 'Luminosité'),
  state: both('Move', 'Mouvement'),
  position: both('Position', 'Position'),
};

/** The name of a feature. */
export function featureName(key, language = 'fr') {
  const name = NAMES[key];
  return name ? word(name, language) : key;
}

const CONFIG_ERRORS = {
  empty: both(
    'Type the address of your Gira server (X1, HomeServer), the user name and password of a user of the server, save, then click "Trust the certificate" twice.',
    "Saisissez l'adresse de votre serveur Gira (X1, HomeServer), l'identifiant et le mot de passe d'un utilisateur du serveur, enregistrez, puis cliquez deux fois sur « Faire confiance au certificat ».",
  ),
  invalid: both('The server address is not valid.', "L'adresse du serveur n'est pas valide."),
  scheme: both(
    'The Gira server answers in HTTPS only: type its address alone.',
    'Le serveur Gira répond en HTTPS seulement : saisissez son adresse seule.',
  ),
  credentials: both(
    'No user name nor password in the address: use the fields below.',
    "Pas d'identifiant ni de mot de passe dans l'adresse : utilisez les champs ci-dessous.",
  ),
  path: both('Type the address alone, without a path.', "Saisissez l'adresse seule, sans chemin."),
  broadcast: both(
    'This address is not one of a device (broadcast or multicast).',
    "Cette adresse n'est pas celle d'un appareil (diffusion ou multicast).",
  ),
  'local-name': both(
    'Names in .local do not resolve in the container: type the IP address of the server.',
    "Les noms en .local ne sont pas résolus dans le conteneur : saisissez l'adresse IP du serveur.",
  ),
  fingerprint: both(
    'The certificate fingerprint is not a SHA-256 one (64 hexadecimal digits).',
    "L'empreinte du certificat n'est pas une SHA-256 (64 caractères hexadécimaux).",
  ),
  'no-credentials': both(
    'Type the user name and password of a user of the Gira server.',
    "Saisissez l'identifiant et le mot de passe d'un utilisateur du serveur Gira.",
  ),
  'no-username': both(
    'A password without a user name: type the user name too.',
    "Un mot de passe sans identifiant : saisissez aussi l'identifiant.",
  ),
  'no-password': both(
    'A user name without a password: type the password too.',
    'Un identifiant sans mot de passe : saisissez aussi le mot de passe.',
  ),
  'bad-username': both(
    'The user name holds a ":" or a control character: not usable.',
    "L'identifiant contient « : » ou un caractère de contrôle : inutilisable.",
  ),
  'bad-password': both(
    'The password holds a control character or is too long: not usable.',
    'Le mot de passe contient un caractère de contrôle ou est trop long : inutilisable.',
  ),
};

const FAILURES = {
  nopin: both('certificate not pinned yet', 'certificat pas encore épinglé'),
  auth: both('authorization refused', 'autorisation refusée'),
  forbidden: both(
    'not allowed for this user (HTTP 403)',
    'pas permis pour cet utilisateur (HTTP 403)',
  ),
  locked: both(
    'the server is locked (project being loaded?)',
    'le serveur est verrouillé (projet en cours de chargement ?)',
  ),
  rate: both('too many requests, paused', 'trop de requêtes, pause'),
  notfound: both('not found on the server', 'introuvable sur le serveur'),
  refused: both('refused by the server', 'refusé par le serveur'),
  server: both('error of the server', 'erreur du serveur'),
  redirect: both('redirected (not a Gira server?)', 'redirigé (pas un serveur Gira ?)'),
  network: both('server unreachable', 'serveur injoignable'),
  timeout: both('no answer in time', 'pas de réponse à temps'),
  size: both('answer too large', 'réponse trop grande'),
  format: both(
    'answer not understood (not a Gira IoT REST API v2?)',
    'réponse non comprise (pas une API IoT REST v2 de Gira ?)',
  ),
  aborted: both('stopped', 'arrêté'),
};

const GUARD_STATES = {
  waiting: both('waiting', 'en attente'),
  noAccount: both('waiting for the configuration', 'en attente de la configuration'),
  authRoute: both(
    'authorization refused on its route, sent again every 5 s',
    'autorisation refusée sur sa route, renvoyé toutes les 5 s',
  ),
  refusedCredentials: both(
    'waiting: user name or password refused, leaves as soon as new ones are saved or the Test succeeds',
    'en attente : identifiant ou mot de passe refusé, part dès que de nouveaux sont enregistrés ou que le test réussit',
  ),
  noPin: both('waiting for the certificate pin', 'en attente de l’épinglage du certificat'),
  pinChanged: both('not sent: the certificate changed', 'pas envoyé : le certificat a changé'),
  locked: both(
    'the server is locked, sent again every 5 s',
    'le serveur est verrouillé, renvoyé toutes les 5 s',
  ),
  sent: both('sent, waiting for the read back', 'envoyé, en attente de la relecture'),
  refused: both('refused by the server', 'refusé par le serveur'),
  noAnswer: both('sent without answer, sent again', 'envoyé sans réponse, renvoyé'),
  notSent: both(
    'server unreachable, sent again every 5 s',
    'serveur injoignable, renvoyé toutes les 5 s',
  ),
  contradicted: both('read back not applied, sent again', 'relu non appliqué, renvoyé'),
  notApplied: both('still not applied after 4 sends', 'toujours pas appliqué après 4 envois'),
  applied: both('applied', 'appliqué'),
  replaced: both('replaced by a newer stop', 'remplacé par un arrêt plus récent'),
  sentNoAnswer: both(
    'sent without answer, read back for 10 s',
    'envoyé sans réponse, relu pendant 10 s',
  ),
  expired: both('given up: too old', 'abandonné : trop ancien'),
  takenUnconfirmed: both('taken, not confirmed', 'pris, non confirmé'),
  alreadyStopped: both('already stopped (Movement 0)', 'déjà arrêté (Movement 0)'),
  excluded: both('function not offered: dropped', 'fonction non proposée : abandonné'),
  done: both('taken by the server', 'pris par le serveur'),
  unknown: both('unknown on the server', 'inconnu du serveur'),
  changedElsewhere: both(
    'dropped: opened elsewhere meanwhile',
    'abandonnée : ouvert ailleurs entre-temps',
  ),
};

const MAX_STATUS = 900;

const guardLine = (g, lang) => {
  const state = word(GUARD_STATES[g.state] ?? GUARD_STATES.waiting, lang);
  const reason = g.reason ? ` (${g.reason})` : '';
  const sends =
    g.sends > 0
      ? lang === 'fr'
        ? `, ${g.sends} envoi(s) répondu(s)`
        : `, ${g.sends} answered send(s)`
      : '';
  return `${g.name}: ${state}${reason}${sends}`;
};

export const T = {
  join(parts) {
    const out = {};
    for (const lang of ['en', 'fr']) {
      out[lang] = parts
        .map((p) => word(p, lang))
        .filter(Boolean)
        .join(' ')
        .slice(0, MAX_STATUS);
    }
    return out;
  },
  configUnread: (s) =>
    both(
      `The configuration could not be read from Gladys; next try in ${s} s.`,
      `La configuration n'a pas pu être lue dans Gladys ; nouvel essai dans ${s} s.`,
    ),
  configError: (code) => CONFIG_ERRORS[code] ?? CONFIG_ERRORS.invalid,
  noPin: both(
    'The certificate of the server is not pinned yet: nothing is sent. Click "Trust the certificate" twice (or type its fingerprint).',
    "Le certificat du serveur n'est pas encore épinglé : rien n'est envoyé. Cliquez deux fois sur « Faire confiance au certificat » (ou saisissez son empreinte).",
  ),
  pinChanged: (fp) =>
    both(
      `The certificate of the server changed: nothing is sent, the password neither (seen: ${fp ?? '?'}). If you replaced the server or renewed its certificate, click "Trust the certificate" twice or type this fingerprint.`,
      `Le certificat du serveur a changé : rien n'est envoyé, le mot de passe non plus (vu : ${fp ?? '?'}). Si vous avez remplacé le serveur ou renouvelé son certificat, cliquez deux fois sur « Faire confiance au certificat » ou saisissez cette empreinte.`,
    ),
  pinNotKept: (fp) =>
    both(
      `Certificate seen (${fp}) but /data could not keep it: type this fingerprint in the configuration.`,
      `Certificat vu (${fp}) mais /data n'a pas pu le garder : saisissez cette empreinte dans la configuration.`,
    ),
  credentialsRefused: both(
    'The Gira server refused the user name or the password: nothing is tried again until new ones are saved or "Test the connection" succeeds.',
    "Le serveur Gira a refusé l'identifiant ou le mot de passe : rien n'est réessayé tant que de nouveaux ne sont pas enregistrés ou que « Tester la connexion » ne réussit pas.",
  ),
  paused: (min) =>
    both(
      `The server asked to slow down (429): reads paused for about ${min} min (stops still leave).`,
      `Le serveur a demandé de ralentir (429) : lectures en pause pour environ ${min} min (les arrêts partent quand même).`,
    ),
  connecting: both('Connecting to the Gira server...', 'Connexion au serveur Gira...'),
  connected: (counts, interval) =>
    both(
      `Connected: ${counts.offered} functions offered, ${counts.scenes} scene functions; read every ${interval} s.`,
      `Connecté : ${counts.offered} fonctions proposées, ${counts.scenes} fonctions de scène ; lecture toutes les ${interval} s.`,
    ),
  truncated: (n) =>
    both(
      `The project holds more than ${n} functions: only the first ${n} are offered.`,
      `Le projet contient plus de ${n} fonctions : seules les ${n} premières sont proposées.`,
    ),
  invalidLists: (n) =>
    both(
      `${n} entry(ies) of the function lists are not function ids: ignored.`,
      `${n} entrée(s) des listes de fonctions ne sont pas des identifiants de fonction : ignorée(s).`,
    ),
  configStale: both(
    'The project of the server changed: read again before any command (stops still leave).',
    'Le projet du serveur a changé : relu avant toute commande (les arrêts partent quand même).',
  ),
  failure: (err) => {
    if (err?.kind === 'pin') return T.pinChanged(err.fingerprint);
    const what = FAILURES[err?.kind] ?? both('error', 'erreur');
    return both(`Gira server: ${what.en}.`, `Serveur Gira : ${what.fr}.`);
  },
  guards: (list) => ({
    en: `Stops kept: ${list.map((g) => guardLine(g, 'en')).join('; ')}.`,
    fr: `Arrêts gardés : ${list.map((g) => guardLine(g, 'fr')).join(' ; ')}.`,
  }),
  dataUnreadable: both(
    '/data is unreadable: read again every 10 s; meanwhile nothing is learnt nor kept (pin, stops).',
    "/data est illisible : relu toutes les 10 s ; en attendant, rien n'est appris ni gardé (épingle, arrêts).",
  ),
  badge: {
    stopKept: both(
      'A stop is kept until read back applied',
      'Un arrêt est gardé jusqu’à sa relecture appliquée',
    ),
    unconfirmed: both('Last command not confirmed yet', 'Dernière commande pas encore confirmée'),
  },
  denied: {
    notCommand: both(
      'This feature cannot be commanded.',
      'Cette fonctionnalité ne se commande pas.',
    ),
    badValue: both(
      'Value refused (out of bounds), nothing sent.',
      'Valeur refusée (hors bornes), rien envoyé.',
    ),
    notConfigured: both(
      'Gira server not configured (address, user name or password): nothing sent.',
      'Serveur Gira non configuré (adresse, identifiant ou mot de passe) : rien envoyé.',
    ),
    credentialsRefused: both(
      'User name or password refused by the server: nothing sent.',
      'Identifiant ou mot de passe refusé par le serveur : rien envoyé.',
    ),
    authRoute: both(
      'Authorization refused on this route: checked again at the next read. Nothing done.',
      'Autorisation refusée sur cette route : revérifiée à la prochaine lecture. Rien fait.',
    ),
    forbidden: both(
      'Not allowed for this user of the Gira server (403): nothing done.',
      'Pas permis pour cet utilisateur du serveur Gira (403) : rien fait.',
    ),
    locked: both(
      'The Gira server is locked (project being loaded?): nothing done.',
      'Le serveur Gira est verrouillé (projet en cours de chargement ?) : rien fait.',
    ),
    paused: both(
      'Paused after a 429 of the server: nothing sent.',
      'En pause après un 429 du serveur : rien envoyé.',
    ),
    noPin: both('Certificate not pinned: nothing sent.', 'Certificat non épinglé : rien envoyé.'),
    notConnected: both(
      'Gira server not connected: nothing sent.',
      'Serveur Gira non connecté : rien envoyé.',
    ),
    configStale: both(
      'The project of the server changed and is not read again yet: nothing sent.',
      "Le projet du serveur a changé et n'est pas encore relu : rien envoyé.",
    ),
    identityChanged: both(
      'This function changed on the server (another kind): nothing sent. Run a Scan and create the device again.',
      "Cette fonction a changé sur le serveur (autre type) : rien envoyé. Lancez un Scan et recréez l'appareil.",
    ),
    controlOff: both(
      'Switching on and dimming are not allowed in the configuration: nothing sent.',
      'Allumer et varier ne sont pas autorisés dans la configuration : rien envoyé.',
    ),
    openOff: both(
      'Opening covers is not allowed in the configuration: nothing sent.',
      "L'ouverture des volets n'est pas autorisée dans la configuration : rien envoyé.",
    ),
    scenesOff: both(
      'Gira scenes are not allowed in the configuration: nothing sent.',
      'Les scènes Gira ne sont pas autorisées dans la configuration : rien envoyé.',
    ),
    sceneUnknown: both(
      'No scene function with this id on the server: nothing sent ("List the scenes" shows them).',
      'Aucune fonction de scène avec cet identifiant sur le serveur : rien envoyé (« Lister les scènes » les montre).',
    ),
    stopInFlight: both(
      'A stop of this device is being sent: nothing sent.',
      'Un arrêt de cet appareil est en cours d’envoi : rien envoyé.',
    ),
    tooLate: both(
      'Not sent in time (3.5 s): nothing sent.',
      'Pas envoyée à temps (3,5 s) : rien envoyé.',
    ),
    cancelled: both(
      'Cancelled by a stop that came after it: nothing sent.',
      'Annulée par un arrêt arrivé après elle : rien envoyé.',
    ),
    notSent: (reason) => both(`Nothing sent (${reason}).`, `Rien envoyé (${reason}).`),
    refused: (reason) =>
      both(`Refused by the server: ${reason}.`, `Refusée par le serveur : ${reason}.`),
    sentUnconfirmed: both(
      'Sent, without confirmation: read back in 5 s.',
      'Envoyée, sans confirmation : relue dans 5 s.',
    ),
    sceneUnconfirmed: both(
      'Scene sent, without confirmation.',
      'Scène envoyée, sans confirmation.',
    ),
    notYetApplied: both(
      'Sent, not applied yet at the read back: read again in 5 s.',
      'Envoyée, pas encore appliquée à la relecture : relue dans 5 s.',
    ),
    replaced: both(
      'Replaced by a newer stop of this device: nothing sent.',
      'Remplacé par un arrêt plus récent de cet appareil : rien envoyé.',
    ),
    stopUnconfirmed: both(
      'Sent, without answer of the server: never sent again (a cover may have moved).',
      'Envoyé, sans réponse du serveur : jamais renvoyé (le volet a pu bouger).',
    ),
    offUnconfirmed: both(
      'Sent, without answer of the server: read back in the next 10 s, sent again only if a read shows it not applied.',
      'Envoyée, sans réponse du serveur : relue dans les 10 s, renvoyée seulement si une lecture la montre non appliquée.',
    ),
    stopTrying: (s) =>
      both(
        `Stop not sent yet (server not reached): tried again for up to ${s} s after your click, then given up. Check the cover and click again if needed.`,
        `Arrêt pas encore parti (serveur pas joint) : réessayé jusqu'à ${s} s après votre clic, puis abandonné. Vérifiez le volet et cliquez de nouveau si besoin.`,
      ),
    stopNotSent: (reason) =>
      both(
        `Stop not sent (${reason}): never sent later, click again.`,
        `Arrêt pas envoyé (${reason}) : jamais envoyé plus tard, cliquez de nouveau.`,
      ),
    excluded: both(
      'This function is in "Functions not offered": nothing sent.',
      'Cette fonction est dans « Fonctions à ne pas proposer » : rien envoyé.',
    ),
    stopKept: (g) =>
      both(
        `Stop kept, sent until applied: ${guardLine(g, 'en')}.`,
        `Arrêt gardé, envoyé jusqu’à son application : ${guardLine(g, 'fr')}.`,
      ),
  },
  test: {
    waiting: (status, s) =>
      both(
        `${status.en} Not read again before the interval: next test possible in ${s} s.`,
        `${status.fr} Pas de nouvelle lecture avant l'intervalle : prochain test possible dans ${s} s.`,
      ),
    paused: (status, s) =>
      both(
        `${status.en} No test during the pause: next test possible in ${s} s.`,
        `${status.fr} Pas de test pendant la pause : prochain test possible dans ${s} s.`,
      ),
    noPin: (fp) =>
      both(
        `The server shows the certificate ${fp}. Nothing was sent. If it is your Gira server, click "Trust the certificate" twice, then test again.`,
        `Le serveur présente le certificat ${fp}. Rien n'a été envoyé. Si c'est votre serveur Gira, cliquez deux fois sur « Faire confiance au certificat », puis testez de nouveau.`,
      ),
    ok: ({ name, type, version, counts }) =>
      both(
        `Connection OK: user accepted, ${name || 'Gira server'} (${type || '?'}, firmware ${version || '?'}), ${counts.offered} functions offered, ${counts.scenes} scene functions.`,
        `Connexion OK : utilisateur accepté, ${name || 'serveur Gira'} (${type || '?'}, micrologiciel ${version || '?'}), ${counts.offered} fonctions proposées, ${counts.scenes} fonctions de scène.`,
      ),
  },
  trust: {
    same: (fp) =>
      both(
        `This certificate is already the trusted one (${fp}).`,
        `Ce certificat est déjà celui de confiance (${fp}).`,
      ),
    typed: (fp) =>
      both(
        `The fingerprint typed in the configuration is the pin: replace it with ${fp} if you trust this one.`,
        `L'empreinte saisie dans la configuration est l'épingle : remplacez-la par ${fp} si vous faites confiance à celui-ci.`,
      ),
    confirm: (fp, first, address) =>
      both(
        `The server shows the certificate ${fp}. Nothing was sent. To check it, open https://${address}/ in a browser on your network and compare its SHA-256 fingerprint (certificate details). Click again within 2 minutes to trust it${first ? ' (trusted from then on: a different one later stops everything)' : ' (only if you replaced the server or renewed its certificate)'}.`,
        `Le serveur présente le certificat ${fp}. Rien n'a été envoyé. Pour le vérifier, ouvrez https://${address}/ dans un navigateur de votre réseau et comparez son empreinte SHA-256 (détails du certificat). Cliquez de nouveau dans les 2 minutes pour lui faire confiance${first ? ' (de confiance à partir de là : un autre plus tard arrête tout)' : ' (seulement si vous avez remplacé le serveur ou renouvelé son certificat)'}.`,
      ),
    done: (fp) => both(`Certificate trusted (${fp}).`, `Certificat de confiance (${fp}).`),
  },
  scenes: {
    none: both(
      'No scene function known yet (read after a successful connection).',
      "Aucune fonction de scène connue pour l'instant (lue après une connexion réussie).",
    ),
    list: (items, more) =>
      both(
        `Scene functions (id: name): ${items.join('; ')}${more ? `; and ${more} more` : ''}.`,
        `Fonctions de scène (identifiant : nom) : ${items.join(' ; ')}${more ? ` ; et ${more} de plus` : ''}.`,
      ),
  },
};
