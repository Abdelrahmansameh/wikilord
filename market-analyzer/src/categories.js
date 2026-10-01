// Turns a card's category (its Wikipedia short description, e.g. "actrice américaine") into groupable tags:
//   theme    one broad theme per category (first matching rule wins, else "Other")
//   country  every country its nationality words point to (can be several, or "(no country)")
//   word     every meaningful word, accents/gender/plural folded ("française" -> "francais")
// Bump TAGS_VERSION after changing any rule: the database re-tags every category on next start.

export const TAGS_VERSION = 1;

export const normalize = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .normalize('NFD')
    .replace(/\p{M}/gu, ''); // drop accents left as combining marks by NFD

const THEMES = [
  ['Wikimedia pages', /wikimedia|homonymie|page de liste/],
  ['Adult film', /pornographi|\bx\b.*film|camgirl/],
  ['Footballers', /footballeu/],
  ['Crime', /criminel|tueur|gangster|meurtrier|escroc|braqueu|terroriste\b|mafieu|trafiquant|affaire criminelle|assassin\b/],
  ['Internet culture', /\bmeme\b|creepypasta|legende urbaine|internet|reseau social|site web|application/],
  ['Dates & names', /^(date|jour|annee|mois)\b|annee du|\bsiecle\b|prenom|nom de famille|patronyme|jour ferie|\bfete\b/],
  ['Actors & actresses', /\b(acteur|actrice|comedien|comedienne|doubleu|doubleuse)/],
  ['Musicians & bands', /duo musical|hard rock|\brock\b|comedie musicale|girl group|boys band|genre musical|festival de musique|tournee|projet musical|orchestre|chanteu|musicien|rappeu|compositeu|groupe de (musique|rock|hip|pop|metal|jazz|rap|punk)|guitariste|bassiste|batteu|pianiste|disc-jockey|\bdj\b|violoniste|auteur-compositeur|interprete/],
  ['Songs & albums', /\b(chanson|album|single|ep|bande originale|clip)\b/],
  ['Athletes', /pratiquant|arts martiaux|sport de combat|biathl|triathl|\b(joueu|athlete|cycliste|tennisman|boxeu|pilote|nageu|skieu|basketteu|rugbyman|handballeu|judoka|lutteu|catcheu|sportif|sportive|gymnaste|patineu|escrimeu|golfeu|alpiniste|grimpeu|entraineu)/],
  ['Politics', /politi(que|cien|cienne)|politologue|haut fonctionnaire|magistrat|\bjuge\b|avocat|depute|senateu|ministre|president|\bmaire\b|homme d'etat|femme d'etat|diplomate|parti\b|syndicaliste|militant/],
  ['Royalty & nobility', /aristocrat|\b(roi|reine|prince|princesse|empereur|imperatrice|duc|duchesse|comte|comtesse|noble|souverain|monarque|pharaon|sultan|dynastie|tsar|marquis)\b/],
  ['Military', /militaire|\bgeneral\b|marechal|officier|soldat|armee|regiment|amiral/],
  ['Religion & mythology', /\b(dieu|deesse|divinite|religion|mythologi|pape|eveque|religieu|moine|pretre|cardinal|theologien|saint|sainte|prophete|bible|biblique)/],
  ['Film makers', /realisateu|scenariste|producteu|cineaste|metteu/],
  ['Writers & journalists', /ecrivain|romancie|poete|poetesse|auteur|journaliste|essayiste|dramaturge|philosophe|historien|editeur|chroniqueu|animateu|presentateu|youtubeu|videaste|influenceu|streameu/],
  ['Artists', /peinture|tableau|drag queen|couturier|peintre|sculpteu|dessinateu|illustrateu|photographe|architecte|mannequin|styliste|createur de mode|danseu|humoriste|artiste/],
  ['Scientists & thinkers', /scientifique|physicien|chimiste|mathematicien|biologiste|medecin|chirurgien|astronome|ingenieu|inventeu|economiste|sociologue|psychologue|psychiatre|botaniste|zoologiste|naturaliste|geographe|linguiste|chercheu|explorateu|astronaute/],
  ['Business people', /entrepreneu|homme d'affaires|femme d'affaires|chef d'entreprise|milliardaire|financier|banquier|\bpdg\b|cuisinier|\bchef\b/],
  ['Fictional characters', /personnage|super-heros|super-heroine|fictif|fictive|de fiction/],
  ['Films', /filmographie|\bfilm\b|court metrage|long metrage|\bcinema/],
  ['TV', /tele realite|episode|televis|\bserie|emission|saison|programme|telefilm|feuilleton|sitcom|telerealite|anime|dessin anime/],
  ['Games', /jeu video|jeux video|jeu de role|console|carte a jouer|jeu de societe|jeu de cartes|pokemon/],
  ['Books & comics', /fable|\bconte\b|poeme|bande dessinee|manga|comics|roman\b|livre|nouvelle\b|recueil|magazine|journal\b|revue\b|saga/],
  ['Space', /galaxie|etoile|planete|asteroide|constellation|nebuleuse|comete|exoplanete|amas|satellite naturel|systeme solaire/],
  ['Plants & fungi', /plante|arbre|champignon|\bfleur|algue|vegetal|arbuste|cultivar|graminee|fougere|mousse/],
  ['Animals', /espece|\brace\b|genre d|famille d|oiseau|mammifere|poisson|insecte|reptile|amphibien|chien|\bchat\b|cheval|dinosaure|animal|araignee|papillon|serpent|requin|baleine/],
  ['French communes', /commune/],
  ['Places', /avenue|boulevard|\bvoie\b|\bcol\b|\bforet\b|\brue\b|\bplace de|autoroute|\broute\b|\bcanal\b|ligne (du metro|de chemin|de tramway|de bus)|cours d'eau|localite|etablissement humain|wilaya|emirat|\bville|village|departement|region|\bpays\b|\bile\b|riviere|fleuve|\blac\b|montagne|\bmont\b|quartier|arrondissement|canton|province|capitale|\bparc\b|plage|desert|massif|\bcote\b|territoire|archipel|vallee|volcan|baie|\bcap\b|peninsule|metropole|agglomeration|lieu-dit|hameau|etat (des|du|de|federe)|subdivision/],
  ['Buildings & monuments', /centrale|base aerienne|barrage|usine|eglise|chateau|cathedrale|monument|stade|batiment|\bpont\b|musee|\btour\b|abbaye|gare|aeroport|basilique|palais|phare|edifice|hopital|universite|lycee|ecole|prison|salle de|theatre|temple|mosquee|synagogue|fort\b|forteresse|station/],
  ['Vehicles', /automobile|voiture|\bavion|navire|bateau|\btrain|locomotive|\bmoto|camion|vehicule|helicoptere|sous-marin|char d'assaut|paquebot|fregate|porte-avions|fusee|aeronef/],
  ['Sports clubs & events', /delegation olympique|\bclub|equipe|franchise|coupe|championnat|tournoi|jeux olympiques|grand prix|competition|ligue|course\b|match|derby|finale/],
  ['Companies & brands', /maison d'edition|entreprise|societe|marque|constructeu|fabricant|chaine de|compagnie|groupe industriel|multinationale|start-up|editeur de|label|restaurant|magasin/],
  ['History & events', /bataille|guerre|attentat|accident|revolution|traite\b|siege\b|massacre|election|catastrophe|seisme|incendie|evenement|crise|affaire|naufrage|epidemie|pandemie|manifestation|emeute|insurrection|conflit|coup d'etat|proces|scandale|assassinat/],
  ['Science & tech', /pistolet|fusil|mitrailleu|appareil|moteur|phenomene|\bnombre|chimique|molecule|maladie|medicament|theoreme|mathemat|physique|logiciel|langage|protocole|unite de|mineral|proteine|\bgene\b|syndrome|virus|bacterie|algorithme|technologie|systeme d'exploitation|ordinateur|smartphone|arme|munition|materiau|composant|equation|concept/],
  ['Food & drink', /cepage|\bplat\b|cuisine|boisson|fromage|\bvin\b|biere|gateau|patisserie|beignet|sauce|aliment|cocktail|dessert|recette|\bfruit|legume|spiritueux|liqueur|pain|viande|confiserie/],
  ['Languages & peoples', /groupe ethnique|\bpeuple|\blangue\b|alphabet|\blettre\b|dialecte|ethnie|tribu/],
  ['Flags & symbols', /drapeau|embleme|blason|armoiries|symbole|hymne|devise\b|monnaie|billet/],
  ['Organisations',/organisation|association|federation|institution|agence|fondation|ong\b|gouvernement|ministere|police|service|administration|groupe terroriste|mouvement|ordre\b|academie/],
];

const COUNTRIES = [
  ['France', /\bfranc(ais|aise|aises)\b|\bfrance\b|\bfranco-|\bparisien|\bbreton|\bcorse\b/],
  ['United States', /\bamericain|etats-unis|\bnew york\b|\bcalifornie|\btexas\b|\bfloride\b|hollywood/],
  ['United Kingdom', /\bbritanniqu|\banglais|\becossais|\bgallois|royaume-uni|\bangleterre\b|\blondres\b|\becosse\b/],
  ['Germany', /\ballemand|\ballemagne/],
  ['Spain', /\bespagnol|\bespagne\b|\bcatalan/],
  ['Italy', /\bitalien|\bitalie\b/],
  ['Japan', /\bjaponais|\bjapon\b/],
  ['Belgium', /\bbelge|\bbelgique|\bbelgo-/],
  ['Canada', /\bcanadien|\bcanada\b|\bquebecois|\bquebec\b/],
  ['Switzerland', /\bsuisse/],
  ['Russia', /\brusse|\brussie\b|sovietique|\burss\b/],
  ['China', /\bchinois|\bchine\b/],
  ['Brazil', /\bbresilien|\bbresil\b/],
  ['Argentina', /\bargentin/],
  ['Mexico', /\bmexicain|\bmexique\b/],
  ['Portugal', /\bportugais|\bportugal\b|-portugais/],
  ['Netherlands', /\bneerlandais|pays-bas|\bhollandais/],
  ['Sweden', /\bsuedois|\bsuede\b/],
  ['South Korea', /coreen|\bcoree\b/],
  ['Australia', /\baustralien|\baustralie\b/],
  ['Poland', /\bpolonais|\bpologne\b/],
  ['Ireland', /\birlandais|\birlande\b/],
  ['Austria', /\bautrichien|\bautriche\b/],
  ['Greece', /\bgrec\b|\bgrecque|\bgrece\b/],
  ['Turkey', /\bturc\b|\bturque|\bturquie\b|ottoman/],
  ['Morocco', /\bmarocain|\bmaroc\b/],
  ['Algeria', /\balgerien|\balgerie\b/],
  ['Tunisia', /\btunisien|\btunisie\b/],
  ['India', /\bindien\b|\bindienne|\binde\b/],
  ['Israel', /\bisraelien|\bisrael\b/],
  ['Egypt', /\begyptien|\begypte\b/],
  ['Norway', /\bnorvegien|\bnorvege\b/],
  ['Denmark', /\bdanois|\bdanemark\b/],
  ['Finland', /\bfinlandais|\bfinlande\b/],
  ['Czechia', /\btcheque/],
  ['Hungary', /\bhongrois|\bhongrie\b/],
  ['Romania', /\broumain|\broumanie\b/],
  ['Ukraine', /\bukrainien|\bukraine\b/],
  ['Senegal', /\bsenegalais|\bsenegal\b/],
  ['Ivory Coast', /\bivoirien|cote d'ivoire/],
  ['Cameroon', /\bcamerounais|\bcameroun\b/],
  ['Colombia', /\bcolombien|\bcolombie\b/],
  ['Chile', /\bchilien|\bchili\b/],
  ['Iran', /\biranien|\biran\b/],
  ['Nigeria', /\bnigerian/],
  ['Ancient world', /antique|\bantiquite|romain\b|romaine\b|\bgaulois|\bceltique|\bviking/],
];

const STOP = new Set(
  ('de du des la le les un une en et au aux pour par sur dans ou qui que est son sa ses ce cette ces il elle se ne pas plus sous ' +
    'entre avec sans vers chez the of and in on at to for by from with an its sorti sortie depuis ete etait nee ses leur leurs ' +
    'dont tres ainsi apres avant lors etc').split(' '),
);

/** Fold gender and plural: "américain(e)(s)" -> "americain", "français" / "française(s)" -> "francai". */
const stem = (w) => {
  for (const end of ['s', 'e', 's']) if (w.length > 4 && w.endsWith(end)) w = w.slice(0, -1);
  return w;
};

/** All tags for one category: [{ kind, tag, label }]. Labels keep the accents for display. */
export function tagsFor(category) {
  const norm = normalize(category);
  const out = [];
  const theme = THEMES.find(([, re]) => re.test(norm))?.[0] ?? 'Other';
  out.push({ kind: 'theme', tag: theme, label: theme });
  const countries = COUNTRIES.filter(([, re]) => re.test(norm)).map(([c]) => c);
  for (const c of countries.length ? countries : ['(no country)']) out.push({ kind: 'country', tag: c, label: c });
  const seen = new Set();
  const raw = String(category ?? '').toLowerCase().replace(/[’`]/g, "'").split(/[^\p{L}\p{N}]+/u);
  for (const word of raw) {
    const n = normalize(word);
    if (n.length < 3 || STOP.has(n) || /^\d+$/.test(n)) continue;
    const s = stem(n);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push({ kind: 'word', tag: s, label: word });
  }
  return out;
}
