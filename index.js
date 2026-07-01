const express = require('express');
const app = express();
app.use(express.json());
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function calculateScore(nutriScore, novaGroup, additivesCount, isOrganic, protein, sugar, sodium) {
  const nutriPoints = { 'a': 50, 'b': 40, 'c': 30, 'd': 15, 'e': 5 };
  const nutriPts = nutriPoints[nutriScore?.toLowerCase()] || 25;
  const novaPoints = { 1: 20, 2: 15, 3: 10, 4: 5 };
  const novaPts = novaPoints[parseInt(novaGroup)] ?? 10;
  const additivePts = Math.max(0, 15 - ((additivesCount || 0) * 3));
  const organicPts = isOrganic ? 10 : 0;
  const proteinPts = (protein && protein >= 10) ? 5 : 0;
  // Sugar penalty: per 100g, >22.5g is "high" by UK FSA standard
  const sugarPenalty = sugar >= 22.5 ? 10 : sugar >= 5 ? 5 : 0;
  const rawScore = nutriPts + novaPts + additivePts + organicPts + proteinPts - sugarPenalty;
  return Math.max(0, Math.min(100, Math.round(rawScore)));
}

function getScoreBreakdown(nutriScore, novaGroup, additivesCount, isOrganic, protein, sugar, sodium) {
  const nutriPoints = { 'a': 50, 'b': 40, 'c': 30, 'd': 15, 'e': 5 };
  const nutriPts = nutriPoints[nutriScore?.toLowerCase()] || 25;
  const novaPoints = { 1: 20, 2: 15, 3: 10, 4: 5 };
  const novaPts = novaPoints[parseInt(novaGroup)] ?? 10;
  const additivePts = Math.max(0, 15 - ((additivesCount || 0) * 3));
  const organicPts = isOrganic ? 10 : 0;
  const proteinPts = (protein && protein >= 10) ? 5 : 0;
  const sugarPenalty = sugar >= 22.5 ? 10 : sugar >= 5 ? 5 : 0;
  return {
    nutriScoreGrade: (nutriScore || 'unknown').toUpperCase(),
    nutriPts, nutriMax: 50,
    novaGroup: parseInt(novaGroup) || null,
    novaPts, novaMax: 20,
    additivesCount: additivesCount || 0,
    additivePts, additiveMax: 15,
    isOrganic: !!isOrganic,
    organicPts, organicMax: 10,
    proteinPts, proteinMax: 5,
    sugarPenalty, sugarPenaltyMax: 10,
  };
}

const additiveMap = {'e100':'Curcumin','e101':'Riboflavin','e102':'Tartrazine','e104':'Quinoline Yellow','e110':'Sunset Yellow','e120':'Carmine','e122':'Carmoisine','e123':'Amaranth','e124':'Ponceau 4R','e127':'Erythrosine','e129':'Allura Red','e131':'Patent Blue','e132':'Indigo Carmine','e133':'Brilliant Blue','e140':'Chlorophyll','e150a':'Caramel Color','e150b':'Caustic Sulfite Caramel','e150c':'Ammonia Caramel','e150d':'Sulfite Ammonia Caramel','e153':'Vegetable Carbon','e160a':'Beta-Carotene','e160b':'Annatto','e161b':'Lutein','e162':'Beetroot Red','e163':'Anthocyanins','e170':'Calcium Carbonate','e171':'Titanium Dioxide','e172':'Iron Oxides','e200':'Sorbic Acid','e202':'Potassium Sorbate','e210':'Benzoic Acid','e211':'Sodium Benzoate','e212':'Potassium Benzoate','e213':'Calcium Benzoate','e220':'Sulfur Dioxide','e221':'Sodium Sulfite','e222':'Sodium Bisulfite','e223':'Sodium Metabisulfite','e224':'Potassium Metabisulfite','e249':'Potassium Nitrite','e250':'Sodium Nitrite','e251':'Sodium Nitrate','e252':'Potassium Nitrate','e260':'Acetic Acid','e261':'Potassium Acetate','e262':'Sodium Acetate','e270':'Lactic Acid','e280':'Propionic Acid','e281':'Sodium Propionate','e282':'Calcium Propionate','e283':'Potassium Propionate','e290':'Carbon Dioxide','e296':'Malic Acid','e297':'Fumaric Acid','e300':'Vitamin C','e301':'Sodium Ascorbate','e302':'Calcium Ascorbate','e306':'Vitamin E','e307':'Alpha-Tocopherol','e310':'Propyl Gallate','e311':'Octyl Gallate','e312':'Dodecyl Gallate','e319':'TBHQ','e320':'BHA','e321':'BHT','e322':'Lecithin','e330':'Citric Acid','e331':'Sodium Citrate','e332':'Potassium Citrate','e333':'Calcium Citrate','e334':'Tartaric Acid','e335':'Sodium Tartrate','e336':'Potassium Tartrate','e337':'Sodium Potassium Tartrate','e338':'Phosphoric Acid','e339':'Sodium Phosphate','e340':'Potassium Phosphate','e341':'Calcium Phosphate','e343':'Magnesium Phosphate','e350':'Sodium Malate','e351':'Potassium Malate','e352':'Calcium Malate','e353':'Metatartaric Acid','e380':'Triammonium Citrate','e400':'Alginic Acid','e401':'Sodium Alginate','e402':'Potassium Alginate','e403':'Ammonium Alginate','e404':'Calcium Alginate','e405':'Propylene Glycol Alginate','e406':'Agar','e407':'Carrageenan','e410':'Locust Bean Gum','e412':'Guar Gum','e413':'Tragacanth','e414':'Acacia Gum','e415':'Xanthan Gum','e416':'Karaya Gum','e417':'Tara Gum','e418':'Gellan Gum','e420':'Sorbitol','e421':'Mannitol','e422':'Glycerol','e432':'Polysorbate 20','e433':'Polysorbate 80','e440':'Pectin','e442':'Ammonium Phosphatides','e450':'Diphosphates','e451':'Triphosphates','e452':'Polyphosphates','e460':'Cellulose','e461':'Methyl Cellulose','e462':'Ethyl Cellulose','e463':'Hydroxypropyl Cellulose','e464':'Hydroxypropyl Methyl Cellulose','e465':'Methyl Ethyl Cellulose','e466':'Carboxymethyl Cellulose','e470':'Fatty Acid Salts','e471':'Mono and Diglycerides','e472a':'Acetic Acid Esters','e472b':'Lactic Acid Esters','e472c':'Citric Acid Esters','e472e':'Diacetyl Tartaric Esters','e473':'Sucrose Esters','e474':'Sucroglycerides','e475':'Polyglycerol Esters','e476':'Polyglycerol Polyricinoleate','e477':'Propylene Glycol Esters','e481':'Sodium Stearoyl Lactylate','e482':'Calcium Stearoyl Lactylate','e491':'Sorbitan Monostearate','e500':'Sodium Carbonates','e501':'Potassium Carbonates','e503':'Ammonium Carbonates','e504':'Magnesium Carbonates','e507':'Hydrochloric Acid','e508':'Potassium Chloride','e509':'Calcium Chloride','e511':'Magnesium Chloride','e512':'Stannous Chloride','e514':'Sodium Sulfates','e515':'Potassium Sulfates','e516':'Calcium Sulfate','e524':'Sodium Hydroxide','e525':'Potassium Hydroxide','e526':'Calcium Hydroxide','e527':'Ammonium Hydroxide','e528':'Magnesium Hydroxide','e529':'Calcium Oxide','e530':'Magnesium Oxide','e535':'Sodium Ferrocyanide','e536':'Potassium Ferrocyanide','e538':'Calcium Ferrocyanide','e541':'Sodium Aluminum Phosphate','e551':'Silicon Dioxide','e552':'Calcium Silicate','e553a':'Magnesium Silicate','e553b':'Talc','e554':'Sodium Aluminosilicate','e555':'Potassium Aluminum Silicate','e556':'Calcium Aluminosilicate','e558':'Bentonite','e559':'Aluminum Silicate','e570':'Fatty Acids','e574':'Gluconic Acid','e575':'Glucono Delta Lactone','e576':'Sodium Gluconate','e577':'Potassium Gluconate','e578':'Calcium Gluconate','e579':'Ferrous Gluconate','e585':'Ferrous Lactate','e620':'Glutamic Acid','e621':'MSG','e622':'Potassium Glutamate','e623':'Calcium Glutamate','e624':'Monoammonium Glutamate','e625':'Magnesium Glutamate','e626':'Guanylic Acid','e627':'Disodium Guanylate','e628':'Dipotassium Guanylate','e629':'Calcium Guanylate','e630':'Inosinic Acid','e631':'Disodium Inosinate','e632':'Dipotassium Inosinate','e633':'Calcium Inosinate','e635':'Disodium Ribonucleotides','e640':'Glycine','e650':'Zinc Acetate','e900':'Dimethyl Polysiloxane','e901':'Beeswax','e902':'Candelilla Wax','e903':'Carnauba Wax','e904':'Shellac','e905':'Microcrystalline Wax','e912':'Montan Acid Esters','e914':'Oxidized Polyethylene Wax','e920':'L-Cysteine','e927b':'Carbamide','e938':'Argon','e939':'Helium','e941':'Nitrogen','e942':'Nitrous Oxide','e943a':'Butane','e943b':'Isobutane','e944':'Propane','e948':'Oxygen','e949':'Hydrogen','e950':'Acesulfame K','e951':'Aspartame','e952':'Cyclamates','e953':'Isomalt','e954':'Saccharin','e955':'Sucralose','e957':'Thaumatin','e959':'Neohesperidin','e960':'Steviol Glycosides','e961':'Neotame','e962':'Aspartame-Acesulfame Salt','e965':'Maltitol','e966':'Lactitol','e967':'Xylitol','e968':'Erythritol','e999':'Quillaia Extract','e1103':'Invertase','e1200':'Polydextrose','e1201':'Polyvinylpyrrolidone','e1202':'Polyvinylpolypyrrolidone','e1404':'Oxidized Starch','e1410':'Monostarch Phosphate','e1412':'Distarch Phosphate','e1413':'Phosphated Distarch Phosphate','e1414':'Acetylated Distarch Phosphate','e1420':'Acetylated Starch','e1422':'Acetylated Distarch Adipate','e1440':'Hydroxypropyl Starch','e1442':'Hydroxypropyl Distarch Phosphate','e1450':'Starch Sodium Octenyl Succinate','e1451':'Acetylated Oxidized Starch'};

// Additive details: name, category, riskLevel (high/limited/safe), description, learnMoreUrl
const additiveDetails = {
  'e100': { category: 'Natural color', riskLevel: 'safe', description: 'Curcumin is the bright yellow pigment found naturally in turmeric root. It has been used for centuries in cooking and traditional medicine. At food-level doses it is considered completely safe, and research even suggests it may have anti-inflammatory benefits.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Curcumin' },
  'e101': { category: 'Color / vitamin', riskLevel: 'safe', description: 'Riboflavin, also known as vitamin B2, is an essential nutrient naturally found in meat, dairy, and leafy greens. When used as a food coloring it gives an orange-yellow hue. It is completely safe and actually beneficial as a vitamin.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Riboflavin' },
  'e102': { category: 'Artificial color', riskLevel: 'high', description: 'Tartrazine is a synthetic lemon-yellow azo dye widely used in sweets, drinks, and snacks. A landmark 2007 UK study found it contributed to hyperactivity in children, leading the EU to require warning labels. It is banned outright in Norway and Austria, and the FDA is reviewing its status in the US as of 2024.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Tartrazine' },
  'e104': { category: 'Artificial color', riskLevel: 'high', description: 'Quinoline Yellow is a synthetic dye that gives a dull yellow-green color. It is included in the EU\'s "Southampton Six" group of dyes linked to hyperactivity in children. It is banned in the US, Australia, Japan, and Norway. Products containing it must carry a warning in the EU.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Quinoline_Yellow_WS' },
  'e110': { category: 'Artificial color', riskLevel: 'high', description: 'Sunset Yellow FCF is a bright orange-yellow azo dye used in beverages, candies, and snack foods. It is one of the "Southampton Six" dyes associated with increased hyperactivity in children. It requires a warning label in the EU and has been voluntarily phased out by several manufacturers.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sunset_yellow_FCF' },
  'e120': { category: 'Natural color', riskLevel: 'limited', description: 'Carmine is a deep red dye made from dried and crushed cochineal insects. While it is natural and generally safe for most people, it can trigger severe allergic reactions — including anaphylaxis — in sensitive individuals. It is not suitable for vegans or vegetarians. The FDA requires it to be listed by name on labels in the US.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Carmine' },
  'e122': { category: 'Artificial color', riskLevel: 'high', description: 'Carmoisine (Azorubine) is a red azo dye used in confectionery, jams, and drinks. It is one of the "Southampton Six" dyes linked to hyperactivity in children and must carry a warning label in the EU. It is banned in the US, Canada, Japan, and Norway.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Carmoisine' },
  'e123': { category: 'Artificial color', riskLevel: 'high', description: 'Amaranth is a dark red azo dye banned in the United States since 1976 after studies suggested a link to cancer in animal tests. It is still permitted in some countries including Russia and EU nations for certain uses. It must carry a hyperactivity warning in the EU.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Amaranth_(dye)' },
  'e124': { category: 'Artificial color', riskLevel: 'high', description: 'Ponceau 4R is a bright red synthetic azo dye used in drinks, desserts, and processed meats. It is one of the "Southampton Six" linked to hyperactivity in children and must carry a warning label in the EU. It is not approved for use in the US or Norway.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Ponceau_4R' },
  'e127': { category: 'Artificial color', riskLevel: 'high', description: 'Erythrosine is a cherry-pink dye made from iodine. High doses in animal studies raised concerns about thyroid disruption and cancer risk. The FDA banned it from maraschino cherries in 1990 but still permits it in certain products. It is banned in the EU for most food applications.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Erythrosine' },
  'e129': { category: 'Artificial color', riskLevel: 'high', description: 'Allura Red (Red 40) is the most widely used artificial food dye in the United States, found in everything from cereals to sodas. It is part of the "Southampton Six" linked to hyperactivity in children, and the EU requires a warning label. The FDA has opened a review of its safety as of 2024. Some states are moving to ban it from school foods.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Allura_Red_AC' },
  'e131': { category: 'Artificial color', riskLevel: 'high', description: 'Patent Blue V is a synthetic blue dye. It is banned in the US, Australia, and Norway due to concerns about cancer risk observed in some animal studies. It can also trigger allergic reactions including anaphylactic shock in rare cases.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Patent_Blue_V' },
  'e132': { category: 'Artificial color', riskLevel: 'limited', description: 'Indigo Carmine is a blue dye derived from indigo. It can cause allergic reactions in sensitive individuals and has been linked to nausea and high blood pressure in large medical doses. At normal food levels the risk is considered low, though it is not permitted in Norway.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Indigo_carmine' },
  'e133': { category: 'Artificial color', riskLevel: 'limited', description: 'Brilliant Blue FCF (Blue 1) is a synthetic dye used in confectionery, drinks, and dairy. It may cause allergic reactions in some people and is banned in several European countries. At typical food levels the scientific consensus is that the risk is low, but it remains under periodic review.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Brilliant_Blue_FCF' },
  'e140': { category: 'Natural color', riskLevel: 'safe', description: 'Chlorophyll is the natural green pigment extracted from plants such as spinach, nettles, and grass. It is widely used as a natural food coloring and is considered completely safe. It has no known health risks and some research suggests mild antioxidant properties.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Chlorophyll' },
  'e150a': { category: 'Color', riskLevel: 'safe', description: 'Plain caramel color is made by heating sugar or glucose syrups without any additives. It is the simplest and safest form of caramel coloring, with no known health concerns at typical levels. It is widely used in sauces, baked goods, and beverages.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Caramel_color' },
  'e150c': { category: 'Color', riskLevel: 'limited', description: 'Ammonia caramel is produced by heating sugars with ammonia. It can contain trace amounts of certain nitrogen-containing compounds. While considered safe at typical food levels by most regulatory agencies, some health researchers have called for more long-term safety data.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Caramel_color' },
  'e150d': { category: 'Color', riskLevel: 'limited', description: 'Sulfite ammonia caramel is the type found in colas and dark soft drinks. It can contain 4-methylimidazole (4-MEI), a compound the International Agency for Research on Cancer (IARC) classifies as possibly carcinogenic at high doses. California requires a warning label when levels are high enough.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Caramel_color' },
  'e160a': { category: 'Natural color', riskLevel: 'safe', description: 'Beta-carotene is the orange pigment naturally found in carrots, sweet potatoes, and pumpkins. The body converts it to vitamin A as needed. It is completely safe as a food coloring and beneficial as a provitamin. It has antioxidant properties and is widely used in margarine, cheese, and juices.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Beta-Carotene' },
  'e160b': { category: 'Natural color', riskLevel: 'limited', description: 'Annatto is a natural orange-yellow coloring extracted from the seeds of the achiote tree. While generally safe, it is one of the more common natural additives to trigger allergic reactions, including hives and irritable bowel syndrome in sensitive individuals. People with aspirin sensitivity may be more prone to reactions.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Annatto' },
  'e161b': { category: 'Natural color', riskLevel: 'safe', description: 'Lutein is a natural yellow carotenoid pigment found abundantly in leafy green vegetables like kale and spinach. As a food coloring it is completely safe. Research suggests lutein is beneficial for eye health, particularly in reducing the risk of age-related macular degeneration.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Lutein' },
  'e162': { category: 'Natural color', riskLevel: 'safe', description: 'Beetroot Red (betanin) is a natural red-purple pigment extracted from red beets. It is considered completely safe with no known health risks. It is heat-sensitive and may discolor urine and stools red in large amounts — a harmless condition called beeturia.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Betanin' },
  'e163': { category: 'Natural color', riskLevel: 'safe', description: 'Anthocyanins are the natural pigments that give berries, red grapes, and purple cabbage their color. They are considered completely safe and are associated with antioxidant and anti-inflammatory benefits in research. They are heat and pH sensitive, shifting from red in acidic to blue-purple in alkaline conditions.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Anthocyanin' },
  'e170': { category: 'Color / acidity regulator', riskLevel: 'safe', description: 'Calcium carbonate is a natural mineral compound found in chalk, limestone, and marble. In food it is used as a white colorant, acidity regulator, and calcium supplement. It is completely safe and is even used in antacids and calcium supplements sold in pharmacies.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Calcium_carbonate' },
  'e171': { category: 'Color / coating', riskLevel: 'high', description: 'Titanium dioxide is a bright white pigment used in candies, chewing gum, and some dairy products. The European Food Safety Authority (EFSA) re-evaluated it in 2021 and concluded it could no longer be considered safe as a food additive due to concerns about genotoxicity — the ability to damage DNA. The EU banned it in food in 2022. It remains permitted in the US, though under increasing scrutiny.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Titanium_dioxide' },
  'e172': { category: 'Color', riskLevel: 'safe', description: 'Iron oxides are naturally occurring mineral pigments that give red, yellow, brown, and black colors. They are used in confectionery and decorative coatings. They are considered completely safe and are even approved for use in cosmetics and pharmaceutical coatings.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Iron_oxide' },
  'e200': { category: 'Preservative', riskLevel: 'safe', description: 'Sorbic acid is a naturally occurring compound first isolated from the berries of the rowan tree. It prevents the growth of mold, yeast, and fungi in foods like cheese, wine, and baked goods. It is widely considered safe by all major regulatory agencies and is one of the least toxic preservatives in use.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sorbic_acid' },
  'e202': { category: 'Preservative', riskLevel: 'safe', description: 'Potassium sorbate is the potassium salt of sorbic acid, one of the most widely used food preservatives in the world. It is effective against mold and yeast in cheese, wine, dried fruit, and baked goods. It is considered safe by the FDA, EFSA, and WHO at typical food levels.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Potassium_sorbate' },
  'e210': { category: 'Preservative', riskLevel: 'high', description: 'Benzoic acid prevents microbial growth in acidic foods and beverages. The key concern is that when combined with vitamin C (ascorbic acid) in drinks, it can form benzene — a known human carcinogen. It is also linked to hyperactivity in children. The UK FSA has advised limiting intake in children\'s products.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Benzoic_acid' },
  'e211': { category: 'Preservative', riskLevel: 'high', description: 'Sodium benzoate is a widely used preservative in soft drinks, juices, and condiments. Like benzoic acid, it can react with vitamin C to form benzene. The 2007 McCann study found it contributed to hyperactivity in children. Some countries have moved to restrict its use in children\'s drinks.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_benzoate' },
  'e220': { category: 'Preservative', riskLevel: 'limited', description: 'Sulfur dioxide is one of the oldest food preservatives, used in wine, dried fruits, and fruit juices to prevent browning and microbial growth. People with asthma or sulfite sensitivity can experience breathing difficulties, skin reactions, or anaphylaxis. The FDA requires foods containing 10ppm or more to declare sulfites on the label.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sulfur_dioxide' },
  'e221': { category: 'Preservative', riskLevel: 'limited', description: 'Sodium sulfite is a sulfite preservative used mainly in wine and dried fruits. It can trigger asthma attacks and allergic reactions in sulfite-sensitive individuals, who make up roughly 1% of the population. People with severe asthma are at greatest risk.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_sulfite' },
  'e223': { category: 'Preservative', riskLevel: 'limited', description: 'Sodium metabisulfite is a sulfite compound used to preserve color and freshness in seafood, wine, and dried fruits. It can cause asthma, hives, and anaphylaxis in sensitive people. Like all sulfites, it must be declared on labels when present above 10ppm in the US and EU.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_metabisulfite' },
  'e249': { category: 'Preservative', riskLevel: 'high', description: 'Potassium nitrite is used to cure and preserve meats, giving them their characteristic pink color. In the body it can convert to nitrosamines, compounds that the WHO classifies as probable carcinogens. The International Agency for Research on Cancer (IARC) classifies processed meats — partly due to nitrites — as Group 1 carcinogens.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Potassium_nitrite' },
  'e250': { category: 'Preservative', riskLevel: 'high', description: 'Sodium nitrite is the primary curing agent in processed meats like bacon, hot dogs, and deli meats. While it prevents botulism, it forms nitrosamines during digestion and cooking at high heat — compounds strongly linked to colorectal cancer. The WHO classifies processed meats as Group 1 carcinogens. Some countries are phasing out nitrites in favor of natural alternatives.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_nitrite' },
  'e251': { category: 'Preservative', riskLevel: 'high', description: 'Sodium nitrate is used to cure meats and is converted to sodium nitrite by bacteria in the body and during processing. It carries similar cancer risks to E250 — linked to colorectal and potentially gastric cancers. The IARC classifies dietary exposure to nitrates from processed meat as a probable carcinogen.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_nitrate' },
  'e252': { category: 'Preservative', riskLevel: 'high', description: 'Potassium nitrate (saltpeter) has been used to cure meats for centuries. Like other nitrates it converts to nitrite in the body, which can form cancer-linked nitrosamines. It is increasingly being replaced in food production, though it remains widely used in some traditional cured meats.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Potassium_nitrate' },
  'e260': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Acetic acid is the compound that gives vinegar its sharp taste and smell. It is produced naturally by fermentation and is one of the most ancient food preservatives known. At food-level concentrations it is completely safe. It has mild antimicrobial properties.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Acetic_acid' },
  'e261': { category: 'Preservative', riskLevel: 'safe', description: 'Potassium acetate is the potassium salt of acetic acid. It is used as a mild preservative and acidity regulator, particularly in salt-restricted products as a substitute for sodium salts. It is considered completely safe by all major regulatory agencies.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Potassium_acetate' },
  'e262': { category: 'Preservative', riskLevel: 'safe', description: 'Sodium acetate is the sodium salt of acetic acid, commonly known as the compound that gives salt-and-vinegar chips their distinctive flavor. It acts as a preservative and acidity regulator. It is considered completely safe and is naturally present in many fermented foods.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_acetate' },
  'e270': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Lactic acid is a naturally occurring organic acid produced during fermentation. It is found in yogurt, cheese, sourdough bread, and pickled vegetables. In food production it regulates acidity and acts as a mild preservative. It is completely safe and is naturally present in the human body.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Lactic_acid' },
  'e280': { category: 'Preservative', riskLevel: 'safe', description: 'Propionic acid is a short-chain fatty acid naturally found in some cheeses and produced in the human gut by bacteria. It is used as a mold inhibitor in bread and baked goods. At typical food levels it is considered safe, though a small number of studies have explored effects on animal behavior at high doses.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Propionic_acid' },
  'e281': { category: 'Preservative', riskLevel: 'safe', description: 'Sodium propionate is the sodium salt of propionic acid. It is used to prevent mold growth in bread, cakes, and other baked goods. It is generally recognized as safe by the FDA and EFSA. A small number of studies have suggested possible behavioral effects in children at very high intake levels.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_propionate' },
  'e282': { category: 'Preservative', riskLevel: 'limited', description: 'Calcium propionate prevents mold in bread and is one of the most common preservatives in commercial baking. A 2002 Australian study found that high doses in children were associated with irritability, restlessness, and sleep disturbances. While regulators consider it safe at current levels, some parents choose to avoid it in children\'s food.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Calcium_propanoate' },
  'e296': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Malic acid is a naturally occurring organic acid found in apples, cherries, and other fruits. It gives a pleasantly tart taste and is used as an acidity regulator and flavor enhancer. It is completely safe and is naturally produced in the human body as part of the Krebs cycle.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Malic_acid' },
  'e297': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Fumaric acid is a naturally occurring organic acid found in some mushrooms and lichen. It is used as an acidity regulator and leavening aid in baked goods, beverages, and wine. It is considered completely safe by all major regulatory agencies.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Fumaric_acid' },
  'e300': { category: 'Antioxidant / vitamin', riskLevel: 'safe', description: 'Vitamin C (ascorbic acid) is an essential nutrient and powerful antioxidant naturally found in citrus fruits, berries, and vegetables. As a food additive it prevents oxidation and browning. It is completely safe and beneficial. It is water-soluble, meaning excess amounts are excreted rather than stored.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Vitamin_C' },
  'e301': { category: 'Antioxidant', riskLevel: 'safe', description: 'Sodium ascorbate is a mineral salt form of vitamin C used as an antioxidant in food. It has the same benefits as ascorbic acid but is less acidic, making it useful for products where acidity must be controlled. It is completely safe and provides vitamin C to the diet.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_ascorbate' },
  'e306': { category: 'Antioxidant / vitamin', riskLevel: 'safe', description: 'Vitamin E (tocopherol) is a fat-soluble essential vitamin and powerful antioxidant found naturally in nuts, seeds, and vegetable oils. As a food additive it prevents fats from going rancid. It is completely safe and beneficial. It protects cell membranes from oxidative damage.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Vitamin_E' },
  'e310': { category: 'Antioxidant', riskLevel: 'limited', description: 'Propyl gallate prevents fats and oils from going rancid. It is often used alongside BHA and BHT. Some individuals experience allergic contact dermatitis or stomach irritation. It has been classified as a possible endocrine disruptor in some studies, and its use is restricted in baby foods.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Propyl_gallate' },
  'e319': { category: 'Antioxidant', riskLevel: 'limited', description: 'TBHQ (tertiary butylhydroquinone) is a synthetic antioxidant used to extend the shelf life of oils, fats, and fried foods. High doses in animal studies caused precancerous lesions and vision disturbances. It is banned in Japan and its use is tightly restricted in the EU. The FDA permits it at low levels in the US.', learnMoreUrl: 'https://en.wikipedia.org/wiki/tert-Butylhydroquinone' },
  'e320': { category: 'Antioxidant', riskLevel: 'limited', description: 'BHA (butylated hydroxyanisole) is a synthetic antioxidant used to preserve fats and oils in snack foods, cereals, and chewing gum. The US National Toxicology Program lists it as "reasonably anticipated to be a human carcinogen." It is banned in Japan and parts of the EU. The FDA still permits it at low levels.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Butylated_hydroxyanisole' },
  'e321': { category: 'Antioxidant', riskLevel: 'limited', description: 'BHT (butylated hydroxytoluene) is a synthetic antioxidant used alongside BHA in processed foods. Some animal studies have raised concerns about liver and kidney effects and possible carcinogenicity at high doses. Other studies suggest it may actually be protective. It is banned in some countries and voluntarily avoided by some manufacturers.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Butylated_hydroxytoluene' },
  'e322': { category: 'Emulsifier', riskLevel: 'safe', description: 'Lecithin is a natural phospholipid found in soybeans, sunflower seeds, and egg yolks. It helps oil and water mix smoothly in products like chocolate and mayonnaise. It is widely considered safe by all regulatory agencies. People with severe soy allergies should check the source, though allergic reactions to soy lecithin are rare.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Lecithin' },
  'e330': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Citric acid is one of the most widely used food additives in the world. It occurs naturally in citrus fruits and is produced industrially by fermenting sugars. It gives a pleasant tartness, acts as a preservative, and enhances other flavors. It is completely safe and naturally present in the human body as part of metabolism.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Citric_acid' },
  'e331': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Sodium citrate is the sodium salt of citric acid. It is used to regulate acidity, enhance flavor, and stabilize emulsions. It is a common ingredient in sports drinks and processed cheese. It is considered completely safe and is used medically as an anticoagulant and urinary alkalizer.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_citrate' },
  'e332': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Potassium citrate is used as an acidity regulator and electrolyte source in food and beverages. It is also used medically to treat kidney stones and gout. As a food additive it is considered completely safe and can benefit people who need to increase their potassium intake.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Potassium_citrate' },
  'e333': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Calcium citrate is used as an acidity regulator and calcium fortification agent. It is one of the most bioavailable forms of supplemental calcium and is used in calcium supplements sold in pharmacies. As a food additive it is completely safe and provides a nutritional benefit.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Calcium_citrate' },
  'e334': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Tartaric acid is a naturally occurring organic acid found abundantly in grapes and tamarinds. It gives wine its characteristic tartness. As a food additive it acts as an acidity regulator and antioxidant synergist. It is considered completely safe at normal food levels.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Tartaric_acid' },
  'e338': { category: 'Acidity regulator', riskLevel: 'limited', description: 'Phosphoric acid gives colas their sharp, tangy taste. While safe in small amounts, regular high consumption — particularly from carbonated drinks — has been associated with lower bone mineral density and increased kidney stone risk. The phosphoric acid in soft drinks is a major contributor to dietary phosphate overload in heavy soda consumers.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Phosphoric_acid' },
  'e339': { category: 'Acidity regulator', riskLevel: 'limited', description: 'Sodium phosphate is used as an acidity regulator, emulsifier, and leavening agent. While safe at low levels, high phosphate intake from multiple processed food sources has been linked to impaired kidney function over time, particularly in people with pre-existing kidney disease. The average Western diet already tends to be high in phosphates.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_phosphate' },
  'e340': { category: 'Acidity regulator', riskLevel: 'limited', description: 'Potassium phosphate is used as an acidity regulator and leavening agent. Like other phosphate additives, cumulative high intake may contribute to impaired kidney function, reduced calcium absorption, and cardiovascular risk. People with kidney disease should be particularly cautious.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Potassium_phosphate' },
  'e341': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Calcium phosphate is a naturally occurring mineral compound used as a firming agent, acidity regulator, and calcium supplement in food. It is considered safe and can contribute positively to calcium intake. It is also used in toothpaste and bone graft materials.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Calcium_phosphate' },
  'e406': { category: 'Thickener', riskLevel: 'safe', description: 'Agar is a natural gelling agent derived from red algae (seaweed). It has been used in Asian cuisine for centuries and is a popular vegetarian/vegan substitute for gelatin. It is considered completely safe, has essentially no calories, and may have mild prebiotic effects on gut bacteria.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Agar' },
  'e407': { category: 'Thickener', riskLevel: 'limited', description: 'Carrageenan is a natural thickener and stabilizer extracted from red seaweed, used in dairy products, plant milks, and deli meats. Laboratory and animal studies have raised concerns about gut inflammation and intestinal lesions. The evidence in humans is mixed — some researchers have called for it to be removed from infant formula. EFSA and the FDA currently consider it safe at food levels.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Carrageenan' },
  'e410': { category: 'Thickener', riskLevel: 'safe', description: 'Locust bean gum (carob bean gum) is a natural thickener and gelling agent derived from the seeds of the carob tree. It is commonly used in ice cream, cheese, and sauces to improve texture. It is considered completely safe and may have mild cholesterol-lowering effects as a soluble fiber.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Locust_bean_gum' },
  'e412': { category: 'Thickener', riskLevel: 'safe', description: 'Guar gum is a natural thickener derived from guar beans, commonly grown in India and Pakistan. It is used in ice cream, baked goods, and gluten-free products. It is considered safe, though consuming very large amounts can cause bloating and gas. It has a low glycemic index and may help with blood sugar control.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Guar_gum' },
  'e414': { category: 'Thickener', riskLevel: 'safe', description: 'Gum arabic (acacia gum) is a natural resin harvested from acacia trees, primarily in sub-Saharan Africa. It is one of the oldest known food additives, used for thousands of years. It acts as a thickener, stabilizer, and emulsifier. It is completely safe, functions as a prebiotic fiber, and is approved for use in organic products.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Gum_arabic' },
  'e415': { category: 'Thickener', riskLevel: 'safe', description: 'Xanthan gum is produced by bacterial fermentation of sugars. It is an extremely effective thickener and stabilizer used in salad dressings, sauces, gluten-free baked goods, and plant-based foods. It is considered completely safe. People with digestive sensitivity may notice laxative effects at high doses.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Xanthan_gum' },
  'e420': { category: 'Sweetener', riskLevel: 'safe', description: 'Sorbitol is a sugar alcohol naturally found in fruits such as apples, pears, and prunes. It provides about 60% of the sweetness of sugar with fewer calories. It is considered safe, though consuming more than 10–20g per day can cause bloating, gas, and diarrhea in sensitive individuals. Products containing it must carry a laxative warning in the EU.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sorbitol' },
  'e421': { category: 'Sweetener', riskLevel: 'safe', description: 'Mannitol is a sugar alcohol naturally found in mushrooms, seaweed, and some fruits. It provides about 60% of the sweetness of sugar and is poorly absorbed, giving it a laxative effect at higher doses. It is used in sugar-free confectionery and pharmaceuticals. Products containing it must carry a laxative warning in the EU.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Mannitol' },
  'e432': { category: 'Emulsifier', riskLevel: 'limited', description: 'Polysorbate 20 is a synthetic emulsifier used to keep oil and water mixed in cosmetics and food. Animal studies at relatively high doses have suggested it may alter the gut microbiome and increase intestinal permeability. Human evidence is limited. It is approved for use in food but some researchers have called for further investigation.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Polysorbate_20' },
  'e433': { category: 'Emulsifier', riskLevel: 'limited', description: 'Polysorbate 80 is a widely used synthetic emulsifier in ice cream, baked goods, and processed foods. A 2015 study in mice found it altered gut microbiome composition and promoted low-grade inflammation. The evidence in humans is not conclusive, but some researchers recommend limiting intake, particularly for those with inflammatory gut conditions.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Polysorbate_80' },
  'e440': { category: 'Thickener', riskLevel: 'safe', description: 'Pectin is a naturally occurring structural polysaccharide found in the cell walls of fruits, particularly apples and citrus peels. It is one of the most natural food additives available and is used as a gelling agent in jams and jellies. It is completely safe, functions as a prebiotic, and may help lower cholesterol and blood sugar levels.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Pectin' },
  'e450': { category: 'Raising agent', riskLevel: 'limited', description: 'Diphosphates are phosphate salts used as raising agents in baked goods and as emulsifiers in processed cheese. While individually safe, cumulative phosphate intake from multiple processed food sources is a growing concern. High dietary phosphate has been associated with impaired kidney function and cardiovascular risk, particularly in people already consuming phosphate-rich foods.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Diphosphate' },
  'e451': { category: 'Raising agent', riskLevel: 'limited', description: 'Triphosphates are used as raising agents, moisture retainers, and emulsifiers in processed meats, seafood, and baked goods. The phosphate concern applies here as well: high cumulative intake may contribute to kidney stress, particularly for those with pre-existing kidney disease or those eating many phosphate-containing processed foods.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Triphosphate' },
  'e452': { category: 'Stabilizer', riskLevel: 'limited', description: 'Polyphosphates are used to help retain moisture in processed meats, seafood, and dairy products. They are effective at preventing water loss during freezing and cooking. As with other phosphate additives, high cumulative intake from multiple sources may contribute to kidney stress and cardiovascular effects over time.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Polyphosphate' },
  'e460': { category: 'Thickener', riskLevel: 'safe', description: 'Cellulose is the structural component of plant cell walls and the most abundant natural polymer on earth. As a food additive it is used as a thickener, anti-caking agent, and source of dietary fiber. It passes through the digestive system undigested and is completely safe. It can contribute to daily fiber intake.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Cellulose' },
  'e466': { category: 'Thickener', riskLevel: 'safe', description: 'Carboxymethyl cellulose (CMC) is a modified cellulose derivative used as a thickener, stabilizer, and emulsifier in ice cream, sauces, and baked goods. It is considered safe at typical food levels. Some animal research has raised questions about gut microbiome effects at very high doses, but this has not been replicated in human studies.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Carboxymethyl_cellulose' },
  'e471': { category: 'Emulsifier', riskLevel: 'safe', description: 'Mono and diglycerides are derived from glycerol and fatty acids — essentially partial fats. They are among the most widely used food emulsifiers, found in bread, margarine, and ice cream. They are considered safe, though they do contribute small amounts of fat to the diet. They may be derived from animal or vegetable sources.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Mono-_and_diglycerides_of_fatty_acids' },
  'e476': { category: 'Emulsifier', riskLevel: 'safe', description: 'PGPR (polyglycerol polyricinoleate) is an emulsifier derived from castor oil. It is primarily used in chocolate to reduce viscosity and allow manufacturers to use less cocoa butter. It is considered safe by EFSA and the FDA. Some consumers prefer to avoid it as an indicator that a product uses less real chocolate.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Polyglycerol_polyricinoleate' },
  'e500': { category: 'Raising agent', riskLevel: 'safe', description: 'Sodium carbonates (including baking soda) are leavening agents that release carbon dioxide when heated, causing baked goods to rise. They are completely safe and have been used in cooking for centuries. Sodium bicarbonate is also used medically as an antacid.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_carbonate' },
  'e501': { category: 'Raising agent', riskLevel: 'safe', description: 'Potassium carbonates are used as acidity regulators and leavening agents, particularly in cocoa processing and some baked goods. They are considered safe and are used in some products as lower-sodium alternatives to sodium carbonates.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Potassium_carbonate' },
  'e503': { category: 'Raising agent', riskLevel: 'safe', description: 'Ammonium carbonates are leavening agents that release ammonia and carbon dioxide when heated, causing baked goods to rise. Unlike sodium bicarbonate, they leave no residue — all the gas escapes during baking. They are considered safe and have been used in traditional biscuit and cookie baking for centuries.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Ammonium_carbonate' },
  'e508': { category: 'Flavor enhancer', riskLevel: 'safe', description: 'Potassium chloride is used as a salt substitute and flavor enhancer in low-sodium foods. It has a slightly bitter or metallic taste at higher concentrations. It is considered safe for healthy adults. People with kidney disease or those taking potassium-sparing medications should consult a doctor before consuming large amounts.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Potassium_chloride' },
  'e509': { category: 'Firming agent', riskLevel: 'safe', description: 'Calcium chloride is used to maintain firmness in canned fruits and vegetables, in cheese-making, and as an electrolyte in sports drinks. It is considered completely safe. It is also used medically to treat calcium deficiencies and cardiac emergencies.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Calcium_chloride' },
  'e551': { category: 'Anticaking agent', riskLevel: 'high', description: 'Silicon dioxide prevents powdered foods from clumping. Concerns have emerged because food-grade silicon dioxide may contain nanoparticles — extremely small particles capable of crossing the intestinal barrier and accumulating in organs. Animal studies have linked it to gut microbiota disruption and inflammation. The EU has flagged it for further safety review, and France temporarily suspended its use in 2019 before a full EFSA assessment.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Silicon_dioxide' },
  'e554': { category: 'Anticaking agent', riskLevel: 'limited', description: 'Sodium aluminosilicate prevents caking in table salt and powdered foods. While most of it passes through the digestive system unabsorbed, trace aluminum absorption raises questions for people with kidney impairment. Current evidence suggests absorption is too low to be a concern for healthy individuals, but some health agencies recommend caution.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_aluminosilicate' },
  'e574': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Gluconic acid is a mild organic acid produced by the oxidation of glucose. It is naturally present in honey, fruit, and wine. It is used as an acidity regulator and sequestrant in food. It is completely safe and is naturally produced in the human body.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Gluconic_acid' },
  'e575': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Glucono delta-lactone (GDL) is a mild natural acidifier used in tofu-making, baked goods, and as a leavening agent. It is derived from glucose and is naturally present in honey and fruit juice. It is considered completely safe.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Glucono_delta-lactone' },
  'e621': { category: 'Flavor enhancer', riskLevel: 'limited', description: 'Monosodium glutamate (MSG) enhances the savory umami taste in foods. It is the sodium salt of glutamic acid, an amino acid naturally found in tomatoes, cheese, and mushrooms. Most regulatory agencies consider it safe. Some people report sensitivity symptoms (headache, flushing) in what was historically called "Chinese restaurant syndrome" — but controlled studies have struggled to consistently reproduce this effect.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Monosodium_glutamate' },
  'e627': { category: 'Flavor enhancer', riskLevel: 'limited', description: 'Disodium guanylate is a flavor enhancer derived from guanosine monophosphate, a nucleotide found in yeast and fish. It amplifies savory taste and is almost always used alongside MSG. It is not suitable for people with gout (it raises uric acid levels) and is not permitted in foods for infants. It is generally safe for healthy adults.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Disodium_guanylate' },
  'e631': { category: 'Flavor enhancer', riskLevel: 'limited', description: 'Disodium inosinate is a flavor enhancer derived from inosine monophosphate, found naturally in meat and fish. It intensifies savory taste and is typically used with MSG and disodium guanylate. Like E627, it raises uric acid and should be avoided by people with gout. It is not suitable for infants or those on purine-restricted diets.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Disodium_inosinate' },
  'e635': { category: 'Flavor enhancer', riskLevel: 'limited', description: 'Disodium ribonucleotides is a combination of E627 and E631, providing a powerful savory flavor boost. It is found in many chips, instant noodles, and snack foods. It should be avoided by people with gout, hyperuricemia, or aspirin sensitivity. Some individuals have reported hives and rashes.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Disodium_ribonucleotides' },
  'e640': { category: 'Flavor enhancer', riskLevel: 'safe', description: 'Glycine is the simplest amino acid and is naturally found in protein-rich foods. As a food additive it provides a mildly sweet flavor. It is considered completely safe and is actually a non-essential amino acid that the human body produces itself.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Glycine' },
  'e900': { category: 'Antifoaming agent', riskLevel: 'safe', description: 'Dimethyl polysiloxane (silicone) is added to cooking oils to prevent foaming during deep frying. It passes through the body without being absorbed. It is considered completely safe and is also found in silicone cookware and medical devices.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Polydimethylsiloxane' },
  'e901': { category: 'Glazing agent', riskLevel: 'safe', description: 'Beeswax is a natural wax produced by honey bees. It is used as a glazing agent on candies, fruits, and tablets to give them a shiny coating and prevent moisture loss. It is completely safe and is also used in cosmetics and pharmaceutical coatings.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Beeswax' },
  'e903': { category: 'Glazing agent', riskLevel: 'safe', description: 'Carnauba wax is derived from the leaves of the carnauba palm tree in Brazil. It gives candies, gummy bears, and fruit a shiny coating. It is considered completely safe, is vegan, and is also widely used in car wax and cosmetics.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Carnauba_wax' },
  'e950': { category: 'Sweetener', riskLevel: 'limited', description: 'Acesulfame K (Ace-K) is an artificial sweetener 200 times sweeter than sugar. It is heat stable and used in baked goods, drinks, and tabletop sweeteners. Some animal studies at very high doses raised concerns about carcinogenicity and neurological effects, but these were conducted at doses far above typical human consumption. The FDA considers it safe, though some researchers advocate for more long-term human studies.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Acesulfame_potassium' },
  'e951': { category: 'Sweetener', riskLevel: 'limited', description: 'Aspartame is one of the most extensively studied food additives in history. It is 200 times sweeter than sugar and used in diet drinks, yogurt, and chewing gum. In 2023 the WHO\'s International Agency for Research on Cancer (IARC) classified it as "possibly carcinogenic to humans" (Group 2B) — the same category as pickled vegetables and aloe vera extract. People with phenylketonuria (PKU) must avoid it as they cannot metabolize phenylalanine.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Aspartame' },
  'e952': { category: 'Sweetener', riskLevel: 'high', description: 'Cyclamate is an artificial sweetener banned in the United States in 1969 after animal studies suggested it may cause bladder cancer. It remains approved in over 50 countries including the EU, Canada, and Australia. Efforts to get it re-approved in the US have been ongoing but unsuccessful. People in countries where it is permitted consume it regularly at the current ADI.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sodium_cyclamate' },
  'e953': { category: 'Sweetener', riskLevel: 'safe', description: 'Isomalt is a sugar alcohol derived from sucrose. It provides about half the calories of sugar and does not cause tooth decay. It is widely used in sugar-free confectionery and hard candies. Consuming large amounts (above 20–30g per day) can cause bloating and a laxative effect. Products containing it require a laxative warning in the EU.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Isomalt' },
  'e954': { category: 'Sweetener', riskLevel: 'limited', description: 'Saccharin was discovered in 1879 and is one of the oldest artificial sweeteners. In the 1970s animal studies suggested bladder cancer risk, leading to mandatory warning labels in the US. Subsequent research found this was specific to rats and not applicable to humans. Warning labels were removed in 2000. It is now considered safe, though some health professionals prefer other sweeteners with more modern safety data.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Saccharin' },
  'e955': { category: 'Sweetener', riskLevel: 'limited', description: 'Sucralose is made from sugar by replacing three hydroxyl groups with chlorine atoms, making it 600 times sweeter and non-caloric. It is widely considered safe by the FDA and EFSA. However, some studies suggest it may alter gut bacteria composition and affect insulin response even without being fully metabolized. A 2023 study also found it may have genotoxic properties, prompting calls for further investigation.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Sucralose' },
  'e960': { category: 'Sweetener', riskLevel: 'safe', description: 'Steviol glycosides are the sweet compounds extracted from the leaves of the stevia plant, native to South America. They are 200–400 times sweeter than sugar with essentially no calories. They are considered safe by the FDA, EFSA, and WHO. Unlike artificial sweeteners, they come from a natural plant source and do not appear to affect blood sugar or gut bacteria negatively.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Steviol_glycoside' },
  'e965': { category: 'Sweetener', riskLevel: 'safe', description: 'Maltitol is a sugar alcohol derived from maltose. It is 90% as sweet as sugar with about half the calories. It is widely used in sugar-free chocolate and candy. It has a higher glycemic index than other sugar alcohols, so diabetics should monitor intake. Consuming large amounts causes bloating and laxative effects. EU products must carry a laxative warning.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Maltitol' },
  'e966': { category: 'Sweetener', riskLevel: 'safe', description: 'Lactitol is a sugar alcohol derived from lactose. It provides about 40% the sweetness of sugar with fewer calories. It is used in sugar-free cookies, chocolate, and chewing gum. It functions as a prebiotic, feeding beneficial gut bacteria. Large amounts can cause bloating and diarrhea. Not suitable for people with lactose intolerance.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Lactitol' },
  'e967': { category: 'Sweetener', riskLevel: 'safe', description: 'Xylitol is a sugar alcohol naturally found in birch trees, corn cobs, and some fruits. It has the same sweetness as sugar but 40% fewer calories and does not raise blood sugar. It is particularly valued for dental health — it actively inhibits the bacteria that cause tooth decay. It is safe for humans but extremely toxic to dogs, even in small amounts.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Xylitol' },
  'e968': { category: 'Sweetener', riskLevel: 'safe', description: 'Erythritol is a sugar alcohol found naturally in fermented foods and some fruits. It has about 70% of the sweetness of sugar with almost no calories (0.2 kcal/g vs 4 kcal/g for sugar). Unlike most sugar alcohols it is almost entirely absorbed and excreted unchanged, so it rarely causes digestive issues. Some research suggests it may have antioxidant properties.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Erythritol' },
  'e1200': { category: 'Bulking agent', riskLevel: 'safe', description: 'Polydextrose is a synthetic soluble fiber made from glucose, sorbitol, and citric acid. It is used as a bulking agent and fat replacer in low-calorie foods. It acts as a prebiotic, feeding beneficial gut bacteria, and may help with blood sugar regulation. It is considered safe by all major regulatory agencies.', learnMoreUrl: 'https://en.wikipedia.org/wiki/Polydextrose' },
};

// OFF's top-level category tags are too broad to produce relevant comparisons —
// matching only on one of these would compare e.g. a protein bar against bottled
// water. If a product's only available tags are this generic, skip recommendations
// entirely rather than show something irrelevant.
const GENERIC_CATEGORY_TAGS = new Set([
  'en:plant-based-foods-and-beverages', 'en:plant-based-foods', 'en:beverages',
  'en:foods', 'en:snacks', 'en:meals', 'en:groceries', 'en:non-alcoholic-beverages',
]);

async function getCategoryAlternatives(currentBarcode, categoriesTags, currentScore) {
  if (!categoriesTags || categoriesTags.length === 0) {
    console.log(`[ALT DEBUG] barcode=${currentBarcode} EARLY EXIT — categoriesTags=${JSON.stringify(categoriesTags)}`);
    return [];
  }

  // Walk from most specific to least specific, skipping anything too generic
  // to use as a search anchor. This only determines the candidate POOL —
  // actual relevance is decided below by comparing full tag overlap.
  let specificTag = null;
  for (let i = categoriesTags.length - 1; i >= 0; i--) {
    if (!GENERIC_CATEGORY_TAGS.has(categoriesTags[i])) {
      specificTag = categoriesTags[i];
      break;
    }
  }
  if (!specificTag) {
    console.log(`[ALT DEBUG] barcode=${currentBarcode} SILENT EXIT — all tags too generic. fullTagList=${JSON.stringify(categoriesTags)}`);
    return [];
  }

  const searchRes = await fetch(
    `https://world.openfoodfacts.org/api/v2/search?categories_tags=${encodeURIComponent(specificTag)}&countries_tags_en=United States&page_size=40&fields=code,product_name,nutriscore_grade,nova_group,additives_tags,labels_tags,nutriments,image_front_url,categories_tags`,
    { headers: { 'User-Agent': 'DontWorryFoodScanner/1.0 (contact: app developer)' } }
  );
  if (!searchRes.ok) {
    console.log(`[ALT DEBUG] barcode=${currentBarcode} search request failed, status=${searchRes.status}`);
    return [];
  }
  const searchData = await searchRes.json();
  const candidates = (searchData.products || []).filter(p => p.code && p.code !== currentBarcode);

  const originalTagSet = new Set(categoriesTags.filter(t => !GENERIC_CATEGORY_TAGS.has(t)));

  // DEBUG: see exactly why candidates pass or fail relevance/score filtering.
  console.log(`[ALT DEBUG] barcode=${currentBarcode} specificTag=${specificTag} candidateCount=${candidates.length} originalTags=${JSON.stringify([...originalTagSet])}`);

  const scoredFull = candidates
    .map(p => {
      const pNutriScore = p.nutriscore_grade || 'c';
      const pNovaGroup = p.nova_group || 3;
      const pAdditivesCount = (p.additives_tags || []).length;
      const pIsOrganic = p.labels_tags?.includes('en:organic') || false;
      const pProtein = p.nutriments?.proteins_100g || 0;
      const pSugar = p.nutriments?.sugars_100g || 0;
      const pSodium = p.nutriments?.sodium_100g || 0;
      const pScore = calculateScore(pNutriScore, pNovaGroup, pAdditivesCount, pIsOrganic, pProtein, pSugar, pSodium);

      // Relevance: how much of this candidate's non-generic category lineage
      // actually overlaps with the scanned product's. Two genuinely similar
      // products (e.g. two protein bars) share most of their tag chain; a
      // protein bar and bottled water only share a top-level tag, which is
      // already excluded from this comparison.
      const candidateTags = (p.categories_tags || []).filter(t => !GENERIC_CATEGORY_TAGS.has(t));
      const sharedTags = candidateTags.filter(t => originalTagSet.has(t)).length;
      const overlapRatio = originalTagSet.size > 0 ? sharedTags / originalTagSet.size : 0;

      return {
        barcode: p.code,
        name: p.product_name || 'Unknown Product',
        score: pScore,
        scoreColor: pScore >= 75 ? '#2E7D32' : pScore >= 50 ? '#8BC34A' : pScore >= 25 ? '#FF9800' : '#F44336',
        scoreLabel: pScore >= 75 ? 'Excellent' : pScore >= 50 ? 'Good' : pScore >= 25 ? 'Poor' : 'Bad',
        imageUrl: p.image_front_url || '',
        overlapRatio,
      };
    });

  // DEBUG: show the top candidates by score with their overlap ratio, so we
  // can see exactly why something passed or failed the relevance/score gate.
  const debugTop = scoredFull
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(p => `${p.name}|score=${p.score}|overlap=${p.overlapRatio.toFixed(2)}`);
  console.log(`[ALT DEBUG] currentScore=${currentScore} top8=${JSON.stringify(debugTop)}`);

  const scored = scoredFull
    // Require at least half the scanned product's specific category tags to
    // match — this is the real relevance gate, not the search tag itself.
    .filter(p => p.name !== 'Unknown Product' && p.score >= 50 && p.score > currentScore && p.overlapRatio >= 0.5)
    .sort((a, b) => b.score - a.score)
    .map(({ overlapRatio, ...rest }) => rest);

  console.log(`[ALT DEBUG] qualified=${scored.length} top5raw=${JSON.stringify(candidates.slice(0,5).map(p => p.product_name))}`);

  return scored.slice(0, 2);
}

app.get('/scan/:barcode', async (req, res) => {
  try {
    const { barcode } = req.params;
    const offRes = await fetch(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`, {
      headers: { 'User-Agent': 'DontWorryFoodScanner/1.0 (contact: app developer)' }
    });
    const offData = await offRes.json();
    const product = offData.product;
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const productName = product.product_name || 'Unknown Product';
    const imageUrl = product.image_front_url || '';
    const ingredients = product.ingredients_text || '';
    const nutriScore = product.nutriscore_grade || 'c';
    const novaGroup = product.nova_group || 3;
    const additiveTags = product.additives_tags || [];
    // Use the actual length of the additives list as the count, not OFF's
    // separate additives_n field — that field can disagree with additives_tags
    // for a given product, causing the count badge to not match the detail list.
    const additivesCount = additiveTags.length;

    const additiveNames = additiveTags.map(a => {
      const key = a.replace('en:', '').toLowerCase();
      return additiveMap[key] || key.toUpperCase();
    }).join(', ') || '';

    // Build rich additive details list for the detail screen
    const additiveList = additiveTags.map(a => {
      const key = a.replace('en:', '').toLowerCase();
      const name = additiveMap[key] || key.toUpperCase();
      const details = additiveDetails[key];
      return {
        code: key,
        name: name,
        category: details?.category || 'Food additive',
        riskLevel: details?.riskLevel || 'safe',
        description: details?.description || 'No additional information available for this additive.',
        learnMoreUrl: details?.learnMoreUrl || `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(name)}`,
      };
    });

    const isOrganic = product.labels_tags?.includes('en:organic') || false;
    const protein = product.nutriments?.proteins_100g || 0;
    const sugar = product.nutriments?.sugars_100g || 0;
    const sodium = product.nutriments?.sodium_100g || 0;
    const score = calculateScore(nutriScore, novaGroup, additivesCount, isOrganic, protein, sugar, sodium);
    const scoreBreakdown = getScoreBreakdown(nutriScore, novaGroup, additivesCount, isOrganic, protein, sugar, sodium);

    // Tier classification — ALWAYS based on official per-100g UK FSA thresholds,
    // even though the number shown to the user is per-serving (see toServing below).
    const sugarTier = sugar >= 22.5 ? 'high' : sugar >= 5 ? 'medium' : 'low';
    const sodiumTier = sodium >= 0.6 ? 'high' : sodium >= 0.12 ? 'medium' : 'low';

    // Category alternatives — best-effort. If this fails (no category data,
    // OFF search hiccup, etc.) the scan should still succeed with an empty list.
    // Only bother looking for alternatives if this product actually needs one —
    // no point suggesting something "better" for an already-Good/Excellent scan.
    let alternatives = [];
    if (score < 50) {
      try {
        alternatives = await getCategoryAlternatives(barcode, product.categories_tags, score);
      } catch (altErr) {
        console.log(`[ALTERNATIVES ERROR] barcode=${barcode} ${altErr.message}`);
      }
    }

    // DEBUG: log raw scoring inputs so we can see exactly what produced a given score.
    // Remove or comment out once formula is verified against real-world products.
    console.log(`[SCORE DEBUG] barcode=${barcode} nutriScore=${nutriScore} novaGroup=${novaGroup} additivesCount=${additivesCount} isOrganic=${isOrganic} protein100g=${protein} sugar100g=${sugar} sodium100g=${sodium} => score=${score}`);

    // Display values: OFF stores nutrients per 100g by default, but a "bar" or "serving"
    // is rarely 100g. Convert to per-serving for display using OFF's own _serving fields
    // when available, falling back to computing from serving_quantity, falling back to
    // per-100g (rare — only when OFF has no serving size data at all for this product).
    const servingQty = product.serving_quantity ? parseFloat(product.serving_quantity) : null;
    const toServing = (val100g, servingVal) => {
      if (servingVal != null) return servingVal;
      if (servingQty) return val100g * servingQty / 100;
      return val100g;
    };
    const proteinDisplay = toServing(protein, product.nutriments?.proteins_serving);
    const sugarDisplay = toServing(sugar, product.nutriments?.sugars_serving);
    const sodiumDisplay = toServing(sodium, product.nutriments?.sodium_serving);

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [{ role: 'user', content: `Product data: sugar ${Math.round(sugarDisplay * 10) / 10}g per serving (${sugarTier} tier), sodium ${Math.round(sodiumDisplay * 1000)}mg per serving (${sodiumTier} tier), protein ${Math.round(proteinDisplay * 10) / 10}g per serving, ${additivesCount} additives, organic: ${isOrganic}, NOVA group ${novaGroup}. Ingredients: ${ingredients}. In one plain English sentence (max 20 words), call out the single most specific health concern or benefit using the actual numbers or ingredient names above. The tier labels given above (low/medium/high) are already correct — match your wording to them exactly, do not recalculate or reclassify based on the numbers yourself. Never say "NOVA group" or any technical jargon — instead describe processing level in plain words like "highly processed" or "minimally processed" if relevant. Name a specific additive if relevant. Avoid vague filler. Write it the way a person would actually say it out loud — avoid stiff constructions like "makes this a sodium concern" or "is the primary nutritional consideration."` }]
      })
    });

    const claudeData = await claudeRes.json();
    const explanation = claudeData.content[0].text;
    const scoreColor = score >= 75 ? '#2E7D32' : score >= 50 ? '#8BC34A' : score >= 25 ? '#FF9800' : '#F44336';
    const scoreLabel = score >= 75 ? 'Excellent' : score >= 50 ? 'Good' : score >= 25 ? 'Poor' : 'Bad';

    res.json({
      productName,
      additiveNames,
      additiveList: JSON.stringify(additiveList),
      ingredients: ingredients,
      nutriScore,
      novaGroup,
      additivesCount: additivesCount === 0 ? 'None' : additivesCount + ' additives',
      isOrganic: isOrganic ? 'Yes' : 'No',
      protein: Math.round(proteinDisplay * 10) / 10 + 'g',
      sugar: Math.round(sugarDisplay * 10) / 10 + 'g',
      sodium: Math.round(sodiumDisplay * 1000) + 'mg',
      sugarTier,
      sodiumTier,
      score,
      scoreBreakdown: JSON.stringify(scoreBreakdown),
      alternatives: JSON.stringify(alternatives),
      explanation,
      scoreColor,
      imageUrl,
      scoreLabel
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.get('/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'Missing search query' });

  try {
    const searchUrl = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=20&fields=code,product_name,image_front_thumb_url,brands,quantity`;
    const response = await fetch(searchUrl);
    const data = await response.json();

    const products = (data.products || [])
      .filter(p => p.code && p.product_name)
      .map(p => ({
        barcode: p.code,
        productName: p.product_name,
        brand: p.brands || '',
        quantity: p.quantity || '',
        imageUrl: p.image_front_thumb_url || '',
      }));

    res.json({ products });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.listen(PORT, () => console.log(`Running on port ${PORT}`));
