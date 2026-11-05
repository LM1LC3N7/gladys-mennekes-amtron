# MENNEKES AMTRON (Modbus TCP)

Cette intégration affiche une borne de recharge **MENNEKES AMTRON 4You
400/500 ou 4Business 600/700** dans Gladys, lue sur votre réseau local en
**Modbus TCP** (port 502), sans cloud. Elle peut mettre la charge en pause et,
seulement si vous l’autorisez, la reprendre et régler le courant de charge.

> **Jamais testé avec un vrai appareil.** Elle a été construite d’après le
> document des registres publié par MENNEKES (« AMTRON 4You 500 / 4Business
> 700 - Modbus TCP Server - Data Points », protocole 1.5, firmware 1.5.21) et
> d’après mennekes-amtron-ha (MIT), et testée sur une borne simulée.
> Non officielle, **sans lien avec MENNEKES**.

## Avant de commencer

1. Dans le **menu installateur** de la borne, activez le **serveur Modbus TCP**
   en mode **« HEMS lecture et écriture »** (registre 2010 = 2). En mode
   « lecture seule », Gladys affiche les valeurs mais la borne refuse la pause
   et les commandes (le statut le dit).
2. Donnez à la borne une **adresse IP fixe** dans votre box.
3. La borne ne sert qu’**un client Modbus à la fois** : Gladys ouvre une
   connexion courte par lecture et la ferme, mais ne laissez pas un autre
   gestionnaire d’énergie garder la connexion.
4. Modbus TCP n’a **pas de mot de passe** : tout appareil de votre réseau peut
   lire et piloter la borne. Gardez-la sur un **réseau de confiance** (pas de
   redirection de port vers internet).

## Configuration

| Champ                          | Sens                                                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| Adresse IP de la borne         | Port Modbus 502 sauf si vous en ajoutez un (`192.168.1.80:502`).                                   |
| Port de l’interface web        | 80 sauf changement : Gladys y lit le numéro de série (`/api/v1/PublicInfo`, sans identifiant).     |
| Autoriser la reprise…          | Désactivé par défaut : voir « Reprise et courant » plus bas.                                       |
| Courant de charge maximal (A)  | De 6 à 16 A (16 par défaut) : le plus que Gladys peut régler (la plage du document, tous modèles). |
| Intervalle de rafraîchissement | Secondes entre deux lectures (30 par défaut, 10 au moins) ; voir « Safe Current » plus bas.        |
| Langue                         | Noms de l’appareil et des fonctionnalités ajoutés désormais, statut et erreurs.                    |

Enregistrez, puis ajoutez la borne depuis l’onglet **Découverte**.

La carte Modbus n’a pas de numéro de série : Gladys le lit sur l’interface
web de la borne (sans identifiant) à **chaque lecture** et avant chaque
commande, à l’adresse même que la connexion Modbus a jointe, et le garde avec
le nom de modèle que la borne donne en Modbus. L’appareil est identifié par
ce **numéro de série** : un autre numéro de série à l’adresse est un autre
appareil (l’ancien apparaît injoignable), et ses valeurs ne vont jamais sur
le premier. Quand la page web est illisible, ce n’est pas une autre borne :
la lecture est publiée si l’appareil se dit AMTRON en Modbus (registre 141 =
« AM ») avec le même modèle, sinon rien n’est publié tant que le numéro de
série n’a pas été relu. Tant que le numéro de série n’a jamais été lu, rien
n’est publié (le statut dit pourquoi).

Le bouton **Tester la connexion** lit la borne une fois, jamais avant
l’intervalle de rafraîchissement après la dernière lecture (il montre alors
le dernier résultat).

## Ce que vous obtenez

| Fonctionnalité                  | Catégorie Gladys               | Remarque                                                 |
| ------------------------------- | ------------------------------ | -------------------------------------------------------- |
| État de la borne                | texte                          | état OCPP : Available, Preparing, Charging, SuspendedEV… |
| Connecteur, état de la charge   | borne de recharge              | d’après l’état OCPP                                      |
| Véhicule branché                | charge VE                      | d’après le pilote (A : pas de véhicule)                  |
| Erreur                          | capteur binaire                | 1 quand un code d’erreur est levé                        |
| En pause par la limite          | capteur binaire                | la limite de courant HEMS est sous 6 A                   |
| Puissance de charge             | capteur d’énergie, W           |                                                          |
| Courant et tension L1, L2, L3   | capteur d’énergie, A et V      | une phase à 0 V (non raccordée) reste inconnue           |
| Compteur d’énergie              | capteur d’énergie, index (kWh) | le compteur total de la borne, gardé (ci-dessous)        |
| Énergie de la session           | charge VE, kWh                 | reste à son maximum jusqu’à la session suivante          |
| Durée de la session             | durée, minutes                 |                                                          |
| Courant proposé au véhicule     | charge VE, A                   |                                                          |
| Limite de courant réglée (HEMS) | charge VE, A                   | registre 2000                                            |
| Mettre en pause / Reprendre     | boutons                        | voir plus bas                                            |
| Courant de charge               | liste, de 6 A au plafond       | voir plus bas                                            |

Une valeur invraisemblable ou non lue reste inconnue, jamais publiée comme 0
ni comme une ancienne valeur. Si un bloc facultatif (session, Safe Current,
courant minimum…) ne répond pas, les autres valeurs sont publiées quand même
(le statut liste ce qui n’a pas été lu).

### Compteur d’énergie

Gladys compte chaque hausse d’un index comme consommation. Le compteur n’est
donc **jamais publié à 0**, et une **baisse** (remise à zéro, borne
remplacée) ou un **saut** plus grand que ce que la borne peut tirer (25 kW)
est **retenu** : rien n’est publié pour lui, le statut le dit avec ses
valeurs, quel que soit le temps. S’il est réel, appuyez sur **Accepter
l’index retenu** : un premier appui l’affiche, un second de 3 s à 5 minutes
après accepte exactement cette valeur.

## Mettre la charge en pause

**Mettre la charge en pause** écrit la limite de courant HEMS à 0 A
(registre 2000). Elle **ne dépend pas de l’option**, ni de la valeur envoyée
par le bouton, ni d’une lecture en cours (elle l’interrompt), ni d’une
commande en attente (elle passe d’abord ; les commandes demandées avant elle
et pas encore envoyées sont abandonnées), ni d’une lecture en échec, d’une
pause entre essais, d’une identité illisible, ni d’une configuration que
Gladys ne peut pas encore lire (elle va alors à la borne de la dernière
lecture).

La pause ne répond une erreur que dans ces cas :

- aucune adresse n’est connue (aucune dans la configuration, ou la
  configuration ne peut pas être lue et aucune borne n’a jamais été lue) ;
- la borne est injoignable pendant 3 s (connexion réessayée toutes les
  250 ms) : « n’a pas encore pu partir », la pause est **gardée** et
  réessayée toutes les 15 s ;
- la borne refuse l’écriture (serveur Modbus TCP pas en mode « HEMS lecture
  et écriture », ou firmware sans registre 2000) : gardée et réécrite toutes
  les 15 s ;
- elle est partie mais la relecture ne la montre pas encore : « envoyée,
  sans confirmation ».

Une pause pas encore vue appliquée est **gardée** dans `/data`, une par borne
(aussi après un redémarrage : elle est réécrite au démarrage, avant tout le
reste, même quand `/data` est lent à lire) et vérifiée toutes les 15 s :
réécrite tant que la borne montre la limite qu’elle remplace, une limite
inconnue ou rien. Elle n’est abandonnée que dans ces trois cas :

- la borne à laquelle elle a été envoyée montre la pause (une limite sous
  6 A) ;
- une autre limite réglée ailleurs est lue deux fois de suite sur cette borne
  après l’écriture de la pause (un choix plus récent est respecté ; une pause
  pas encore écrite n’est jamais abandonnée ainsi) ;
- un courant ou une reprise plus récents demandés dans Gladys sont partis
  vers cette même borne.

Elle n’est jamais abandonnée avec le temps, ni parce qu’elle n’a pas pu
partir (borne coupée, `/data` bloqué), ni par une pause ou une commande
envoyée à une autre adresse : une pause gardée pour une ancienne adresse (la
configuration a changé) reste vérifiée toutes les 15 s, avec sa note dans le
statut, tant qu’elle n’est pas vue appliquée. Tant qu’une pause est gardée, « Courant de
charge » et « Reprendre » écrivent toujours (jamais « déjà fait »), et cette
écriture abandonne la pause.

### Safe Current

En mode « HEMS lecture et écriture », la borne surveille la communication :
après son **délai de communication** (registre 132) sans lecture ni
écriture, elle applique son **Safe Current** (registre 131). Si le Safe
Current est au-dessus de la limite réglée (une pause comprise), la charge
reprendrait. Tant que c’est le cas, Gladys lit donc la borne au moins toutes
les demi-durées de ce délai (5 s au moins ; un délai sous 10 s ne peut donc
pas être tenu), une lecture en échec réessayée dans les 5 s, une lecture qui trouve la
ligne occupée réessayée dans la seconde, et tout de suite
après un redémarrage (le rythme est gardé dans `/data`), et aussi
pendant une pause quand 131 et 132 ne peuvent pas être lus ; et le
statut prévient que la pause ne tient que tant que Gladys lit la borne. Pour
garder une pause même Gladys arrêté, réglez le Safe Current à 0 A dans le
menu installateur. Gladys n’écrit jamais ces deux registres.

## Reprise et courant

Désactivé par défaut. Avec **Autoriser la reprise et le courant**, Gladys
peut :

- **Reprendre la charge** : réécrit le courant de charge lu avant la pause
  (refusé si aucun n’a été lu ; choisissez-en un dans la liste) ;
- régler le **courant de charge** : de 6 A jusqu’au plafond configuré, 16 A
  au plus pour tous les modèles, jamais sous le courant minimum donné par la
  borne (registre 712). Le document MENNEKES donne 6 A à 16 A pour le
  registre 2000 ; au-delà de 16 A sur un modèle 22 kW n’y figure pas, Gladys
  ne l’écrit donc jamais.

Avant chaque commande, Gladys lit le numéro de série sur l’interface web
(une autre borne, ou un numéro illisible, refuse la commande), puis, dans la
même connexion Modbus, le Device Id, le modèle, le mode HEMS et la limite de
courant. Elle refuse pendant l’envoi d’une pause, revérifie l’option et la
configuration juste avant l’écriture, et **ne confirme que par une
relecture** montrant la valeur demandée. Sinon elle répond « envoyée, sans
confirmation » (vérifiez dans quelques secondes) ou « rien envoyé ». Les
commandes partent une à la fois, dans leur ordre d’arrivée ; une commande qui
attend son tour part dans les 15 s ou pas du tout.

## Données gardées

`/data/mennekes-amtron-state.json` (lisible par l’intégration seule) :
l’heure de la dernière lecture, la borne de la dernière lecture, son numéro
de série et son modèle, les pauses pas encore vues appliquées, le rythme de
lecture tant qu’une limite sous le Safe Current est réglée, la garde du
compteur d’énergie et le courant que « Reprendre » réécrit. Aucun mot de
passe, aucune donnée personnelle.
