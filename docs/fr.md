# Gira X1 / HomeServer

Cette intégration relie votre Gira X1, HomeServer ou FacilityServer à Gladys
par l'**API IoT REST v2 de Gira** du serveur, sur votre réseau local. Non
officiel, sans lien avec Gira (Gira Giersiepen GmbH & Co. KG).

**Jamais testé avec un vrai appareil pour l'instant** : l'intégration a été
écrite d'après la documentation officielle « Gira IoT REST API v2 » (Gira,
juillet 2020) et testée contre un serveur simulé. Vos retours sont bienvenus.

## Serveurs

La documentation de Gira cite le **Gira X1** (micrologiciel 2.4 ou plus
récent) et le **Gira HomeServer / FacilityServer** (micrologiciel 4.10 ou plus
récent). Le serveur **Gira One** n'est pas dans cette documentation : il
fonctionne s'il répond à la même API (`GDS-REST-API`, version 2), ce que
vérifie « Tester la connexion ».

## Ce que vous obtenez

Les fonctions de votre projet (telles que configurées dans le Gira Project
Assistant, GPA) sont proposées dans l'onglet **Découverte** :

- **Lumières commutées** : allumé/éteint ;
- **Variateurs**, **lumières de couleur** et **lumières blanc réglable** :
  allumé/éteint et luminosité (la couleur et la température de couleur ne sont
  pas encore pilotées) ;
- **Volets et stores** : ouvrir, fermer, arrêter, et la position quand la
  fonction en a une (les lamelles ne sont pas encore pilotées).

Les **scènes** du serveur se lancent depuis les scènes de Gladys, avec
l'action de scène **Lancer une scène Gira** (voir plus bas).

Pas proposés : chauffage et climatisation, sauna, audio, caméras, liens,
valeurs d'état, émetteurs de valeur, et les fonctions « Trigger » et « Press
and hold » (elles peuvent commander une gâche de porte).

Les identifiants des appareils sont les identifiants (UID) que le serveur donne
à chaque fonction (`function:<uid>`) : ils ne changent pas avec une mise à jour
du micrologiciel, et la documentation de Gira dit qu'un UID n'est pas redonné
de sitôt à autre chose. Une fonction supprimée puis recréée dans le GPA est un
nouvel appareil.

## Configuration

1. Dans le GPA, créez un **utilisateur** pour Gladys sur le serveur (le mieux
   est un utilisateur réservé).
2. Dans Gladys, saisissez l'**adresse IP** du serveur, l'**identifiant** et le
   **mot de passe**, puis **enregistrez**. Les noms en `.local` ne sont pas
   résolus dans le conteneur.
3. Cliquez sur **Faire confiance au certificat** : l'empreinte du certificat du
   serveur s'affiche, rien d'autre n'est envoyé. Cliquez de nouveau dans les
   2 minutes pour lui faire confiance.
4. Cliquez sur **Tester la connexion** : il vérifie l'API, l'utilisateur et lit
   le projet.
5. Ajoutez les appareils voulus depuis l'onglet **Découverte**.

Le mot de passe est gardé par Gladys dans sa base, jamais réaffiché, envoyé
seulement au serveur à l'adresse saisie, et seulement sur une connexion dont le
certificat est celui de confiance. Il inscrit le client
`io.github.lm1lc3n7.gladys-gira` auprès du serveur (`POST /clients`), qui
donne un jeton ; le jeton reste en mémoire seulement (le serveur redonne le
même au démarrage suivant du conteneur). Un identifiant ou un mot de passe
refusé par le serveur n'est jamais réessayé tout seul : l'intégration attend
de nouveaux identifiants ou un « Tester la connexion » réussi (seule une
marque de 6 bits des identifiants refusés est gardée dans `/data`, jamais
assez pour les retrouver).

### Certificat du serveur

Le serveur a un certificat qu'aucun navigateur n'accepte (Gira le dit dans sa
documentation). À la place, l'intégration fait confiance à un certificat :
confirmé par vos deux clics sur **Faire confiance au certificat**, ou saisi
dans le champ **Empreinte du certificat**. Sans lui, rien n'est envoyé du
tout. Si un autre certificat se présente (serveur remplacé, certificat
renouvelé, ou autre appareil à cette adresse), rien n'est envoyé, ni un arrêt
ni le mot de passe, et le statut affiche l'empreinte vue. Pour lui faire
confiance : cliquez deux fois sur **Faire confiance au certificat**, ou
saisissez cette empreinte dans la configuration.

## Ce qui part toujours, ce qui est désactivé par défaut

**Désactivé par défaut** : Gladys ne fait que lire. Trois options ouvrent le
reste :

- **Autoriser l'allumage et la variation** : allumer une lumière, régler une
  luminosité ;
- **Autoriser l'ouverture des volets** : ouvrir un volet, ou le placer à une
  position (toute position sauf fermé peut l'ouvrir) ;
- **Autoriser les scènes Gira** : une scène du serveur peut tout allumer et
  ouvrir des volets ou des portes.

L'option est relue juste avant l'envoi : désactivée pendant qu'une commande
attend, la commande est refusée.

**Partent toujours**, quelles que soient les options : éteindre une lumière
(une luminosité de 0 est une extinction), arrêter un volet, fermer un volet
(une position de 0 est une fermeture). Aucune option, aucune pause 429, aucun
projet en cours de relecture, aucune lecture ni commande en cours ne les
retient. Ils annulent les commandes de la même cible encore en attente : rien
de demandé avant un arrêt ne part après lui.

Un arrêt ne part pas seulement dans ces cas ; il est alors **gardé** (le statut
le dit) et envoyé dès que possible :

- identifiant ou mot de passe absent ou invalide, ou refusé par le serveur :
  il part en premier dès que de nouveaux sont enregistrés ou que « Tester la
  connexion » réussit ;
- pas de certificat de confiance, ou certificat changé : il part une fois le
  certificat accepté ou reconnu ;
- serveur injoignable, verrouillé (423, pendant le chargement d'un projet), ou
  route refusée (401/403) : il est renvoyé toutes les 5 secondes, sans limite
  de temps ;
- avant la première lecture de la configuration dans Gladys (démarrage du
  conteneur) : il est refusé, rien envoyé (l'adresse n'est pas encore connue).

Après un redémarrage du conteneur, le premier arrêt inscrit de nouveau le
client avant de partir. Un arrêt sur un point de données que le serveur ne
connaît plus (404) est abandonné.

Une extinction reste gardée, aussi dans `/data` (un redémarrage du conteneur
l'envoie en premier, dès la configuration lue), jusqu'à ce qu'une lecture
partie après la réponse du serveur la montre appliquée. Si la lecture montre
le contraire, elle est renvoyée ; seuls les envois auxquels le serveur a
répondu comptent, 4 au plus. Après 4 refus du serveur ou 4 envois non
appliqués, elle reste gardée et affichée, sans nouvel envoi, jusqu'à ce qu'une
lecture la montre appliquée ou qu'une commande plus récente arrive. Une
commande plus récente de la même cible, prise par le serveur, la remplace.

Un mouvement de volet (fermer, arrêter) est fait dès que le serveur l'a pris,
et n'est jamais rejoué après un redémarrage. Une fermeture qui n'a pas atteint
le serveur est d'abord réessayée deux fois dans les 250 ms environ qui suivent
votre clic ; ensuite, sur un volet qui a une position, elle n'est renvoyée
qu'après une lecture de la position, une fois par lecture : fermé ou en train
de se fermer, c'est fait ; lu plus ouvert qu'au moment du clic deux fois de
suite, il a été ouvert à la main entre-temps et la fermeture est abandonnée.
Sur un volet sans position, elle est renvoyée toutes les 5 secondes jusqu'à
ce que le serveur la prenne.

Conventions KNX utilisées : « Up-Down » 0 ouvre et 1 ferme ; un arrêt est
« Step-Up-Down » 1, qui arrête un volet en mouvement (sur un volet à l'arrêt,
l'actionneur fait un petit pas vers le bas ou rien) ; la position du serveur
est en pourcentage fermé, affichée dans Gladys en pourcentage ouvert.

**Vérifiez votre projet** : sur un **store banne**, « fermer » (descendre) le
déploie. Si une fonction « Volet et store » de votre projet commande une
**porte de garage ou un portail**, ne l'ajoutez pas à Gladys : la fermeture
n'est jamais retenue.

## Scènes

1. Autorisez les scènes (option **Autoriser les scènes Gira**).
2. Cliquez sur **Lister les scènes** : il affiche les fonctions de scène du
   projet avec leur identifiant, par exemple `a0f1: Soirée`.
3. Dans une scène de Gladys, ajoutez l'action **Lancer une scène Gira** avec
   cet identifiant et le **numéro de scène** (0 à 64), envoyé tel quel au point
   de données « Execute » d'un ensemble de scènes (ou « Scene » d'une extension
   de scène), tel que réglé dans le GPA.

Une scène est refusée quand l'option est désactivée, quand l'identifiant n'est
pas une fonction de scène du projet, quand le projet est en cours de
relecture, et pour les mêmes raisons que toute autre commande (serveur non
connecté, pause 429...). Tout arrêt arrivé pendant qu'une scène attend
l'annule.

## Ce que dit une commande refusée

Une commande (autre qu'un arrêt) part dans les 3,5 secondes ou pas du tout :
« rien envoyé » dit qu'elle n'est jamais partie. « Refusée par le serveur »
donne sa raison ; « verrouillé » dit qu'un projet est en cours de chargement ;
« Pas permis pour cet utilisateur (403) » que l'utilisateur n'a pas ce droit
dans le GPA. « Envoyée, sans confirmation » dit qu'elle est partie sans
réponse ; « pas encore appliquée » qu'une relecture ne la montre pas encore.
Dans ces deux derniers cas, l'appareil est relu après 5 et 20 secondes et son
badge le dit en attendant. L'ouverture d'un volet (« Up-Down ») ne se relit pas
(écriture seule) : elle est faite dès que le serveur l'a prise, et la position
est relue après 5 et 20 secondes.

## Lectures

Le serveur ne peut pas joindre le conteneur de l'intégration, ses rappels
(callbacks) ne sont donc pas utilisés : l'intégration lit à l'**intervalle**
choisi (60 s par défaut, 30 s au moins). Chaque lecture demande l'identifiant
du projet (`uiconfig/uid`) et, s'il a changé (chargement depuis le GPA,
modification dans l'app Gira), tout le projet de nouveau ; aucune commande
sauf les arrêts ne part avant qu'il soit lu. Puis les valeurs de chaque
appareil créé dans Gladys, une requête à la fois (150 par lecture au plus, à
tour de rôle au-delà). Une fonction dont les valeurs sont refusées (401, 403)
est relue plus tard (deux fois l'intervalle, doublé jusqu'à 1 heure), sans
arrêter les autres.

Jamais plus vite : ni le bouton Scan (qui republie la Découverte sans lire),
ni « Tester la connexion » (qui dit alors quand il pourra tester de nouveau),
ni un redémarrage du conteneur ne lisent avant l'intervalle qui suit la
dernière lecture ; une autre adresse, un autre identifiant ou un autre mot de
passe enregistré lit tout de suite. Tant que l'utilisateur est refusé,
« Tester la connexion » essaie tout de suite, une fois par 10 secondes.
Pendant une pause demandée par le serveur (429), ni le bouton de test ni les
lectures n'envoient de requête ; seuls les arrêts partent.

## Limites connues

- Couleur, température de couleur et lamelles ne sont pas encore pilotées.
- Pas de mises à jour en direct : les changements faits ailleurs sont vus à la
  lecture suivante.
- Les numéros de scène sont envoyés tels que saisis : vérifiez-les dans votre
  GPA.

## Dépannage

- **« Le certificat du serveur a changé »** : voir plus haut.
- **« Le serveur Gira a refusé l'identifiant ou le mot de passe »** : vérifiez
  l'utilisateur dans le GPA, enregistrez le bon mot de passe ou cliquez sur
  « Tester la connexion ».
- **« Le serveur est verrouillé »** : un projet est en cours de chargement
  depuis le GPA ; cela revient tout seul.
- **« /data est illisible »** : l'intégration fonctionne, mais n'apprend et ne
  garde rien (certificat, arrêts) ; saisissez l'empreinte du certificat dans la
  configuration.
