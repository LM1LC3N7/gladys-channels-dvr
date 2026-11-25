# Channels DVR

Suivez votre **serveur Channels DVR** (enregistrements en cours et à venir,
espace du disque des enregistrements) et pilotez les **applications
Channels** de vos téléviseurs (pause, reprise, arrêt, muet, chaîne) depuis
Gladys, sur le réseau local.

Intégration non officielle, sans lien avec Fancy Bits (Channels). Elle n'a
**jamais été testée avec un vrai Channels** : elle est écrite d'après la
documentation officielle de l'API du serveur et de l'API des applications, et
testée sur des serveurs simulés. Vos retours sont les bienvenus.

## Ce qu'il faut

- Channels DVR Server sur votre réseau (port 8089), et/ou l'application
  Channels sur une Apple TV, une Fire TV ou un appareil Android TV (son API
  écoute sur le port 57000).
- Ni compte ni mot de passe : Channels n'en demande pas sur le réseau local.
  Les deux API sont en http simple ; l'intégration ne leur parle que sur
  votre réseau local.
- Channels et son service DVR sont officiellement disponibles aux États-Unis,
  au Canada et au Royaume-Uni.

## Configuration

- **Adresse du serveur Channels DVR** : `192.168.1.3` ou
  `http://192.168.1.3:8089` (8089 si aucun port n'est saisi). https, un
  chemin ou des identifiants sont refusés. Laissez vide pour ne suivre que
  des lecteurs.
- **Applications Channels (lecteurs)** : les adresses des appareils où tourne
  l'application, séparées par des virgules, port `57000` par défaut, un nom
  avant un signe égal si vous le souhaitez :
  `Salon=192.168.1.20, Chambre=192.168.1.21`. Dix au plus.
- **Intervalle de rafraîchissement** : de 15 s à 5 min (30 s par défaut).

Un lecteur est repéré par son **adresse** : l'application Channels ne donne
ni numéro de série ni autre identifiant. Réservez son IP dans votre box ; une
nouvelle adresse crée un nouvel appareil dans Gladys (l'ancien reste, sans
valeurs).

## Appareils

**Channels DVR** (lecture seule) :

| Fonction                      | Valeur                                                                    |
| ----------------------------- | ------------------------------------------------------------------------- |
| Enregistrements en cours      | tâches dont la plage contient l'heure du serveur, ni ignorées ni en échec |
| Enregistrements à venir       | tâches qui commencent plus tard, non ignorées                             |
| Enregistrement en cours       | noms des enregistrements en cours, `—` sinon                              |
| Prochain enregistrement       | nom du prochain enregistrement, `—` sinon                                 |
| Disque libre / Disque utilisé | Go (10^9 octets), lus toutes les 5 minutes                                |

C'est l'heure du **serveur** qui décide de ce qui s'enregistre (son en-tête
`Date`), pas l'horloge de Gladys. Une réponse sans cet en-tête laisse les
comptes inconnus. Le disque vient de `/dvr`, une route hors de l'API
documentée du serveur : si elle ne répond pas, le disque reste inconnu et les
enregistrements sont lus quand même.

**Chaque lecteur** :

| Fonction                     | Valeur                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------ |
| Lecture                      | en lecture, en pause, à l'arrêt ; écrire `0` pause, `1` reprise, `2` arrêt     |
| En cours de lecture          | titre et épisode, vide si rien ne joue                                         |
| Muet                         | `1` muet ; modifiable                                                          |
| Chaîne                       | la chaîne regardée (`12.1` pour une sous-chaîne) ; l'écrire règle cette chaîne |
| Nom de la chaîne             | `—` si aucune chaîne n'est regardée                                            |
| Chaîne suivante / précédente | boutons                                                                        |
| Application qui répond       | `1` l'application répond sur son port, `0` non                                 |

Sur Apple TV, l'application ne répond que lorsqu'elle est ouverte et au
premier plan ; sur Android et Fire TV, aussi en arrière-plan une fois lancée.
Quand le port refuse la connexion (application fermée), le lecteur affiche
_à l'arrêt_ et un titre vide. Quand il ne répond pas du tout à une lecture périodique (appareil en
veille, réseau), seule _Application qui répond_ passe à `0` : les autres
valeurs restent telles quelles, inconnues.

## Commandes

- Chaque commande lit d'abord l'état de l'application, puis décide : mettre
  en pause une application déjà en pause ou régler la chaîne déjà affichée
  n'envoie rien ; reprendre quand rien ne joue est refusé (réglez d'abord une
  chaîne).
- Une commande reçoit sa réponse en 3,5 s environ. Elle ne réussit que si
  l'application montre l'état demandé (dans sa réponse, ou dans une relecture
  faite dans ce délai). Sinon Gladys reçoit l'erreur « envoyée, sans
  confirmation » : des relectures 1,5 s et 5 s plus tard publient ce que fait
  l'application, et un avertissement est journalisé si elle ne le montre pas.
  Une commande refusée par l'application (HTTP 4xx) le dit ; « rien envoyé »
  n'est dit que si aucune connexion n'a eu lieu.
- Les commandes vers un même lecteur passent l'une après l'autre ; deux
  lecteurs sont pilotés en même temps. Une commande qui attend au-delà de son
  temps est abandonnée, pas envoyée en retard.
- Le muet est une bascule dans Channels : il n'est envoyé que sur un état lu
  juste avant, et un second changement est refusé (6 s au plus) tant que le
  premier n'est pas vu appliqué.
- Rien d'autre n'est envoyé : aucun enregistrement lancé ou supprimé, aucun
  réglage.

## Lectures

- Les lectures périodiques : chaque cible une fois par intervalle, un tour à la fois. L'heure
  de chaque tentative est écrite dans `/data` **avant** la lecture : un
  redémarrage, une reconnexion à Gladys ou la configuration enregistrée à
  nouveau ne lit pas une cible plus tôt que l'intervalle (un nouveau lecteur
  est lu tout de suite). Hors de ces tours, une commande lit son lecteur
  juste avant (et une fois de plus si sa réponse ne la montre pas appliquée),
  puis 1,5 s et 5 s plus tard si elle n'est toujours pas vue.
- Le bouton de test donne les dernières lectures ; il ne lit que les cibles
  dont c'est le tour.
- Si `/data` est illisible, les premières lectures attendent un intervalle
  entier et le fichier est relu toutes les 10 s ; il n'est pas écrasé
  entre-temps.

## Statut

L'intégration est affichée connectée tant que le serveur ou au moins un
lecteur répond (une application fermée est un état normal : quand des
lecteurs refusent la connexion, le statut le dit et évoque une application
fermée, ou une adresse ou un port faux). Elle dit ce qui
ne répond pas et pourquoi, et quelles entrées de la configuration sont
ignorées.

## Limites

- Jamais testée sur du vrai matériel (voir plus haut).
- Une pause ou un changement de chaîne plus court que l'intervalle peut
  échapper aux lectures (pas aux commandes).
- Un numéro de chaîne qu'un nombre de Gladys ne peut pas écrire exactement
  (`12.10`) n'est pas publié comme _Chaîne_ (son nom l'est) ; régler `12.1`
  dessus est envoyé, jamais pris pour fait.
