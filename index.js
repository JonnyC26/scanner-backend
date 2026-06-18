const express = require('express');
const app = express();
app.use(express.json());
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function calculateScore(nutriScore, novaGroup, additivesCount, isOrganic, protein, sugar, sodium) {
  const nutriPoints = { 'a': 50, 'b': 40, 'c': 30, 'd': 15, 'e': 5 };
  const nutriPts = nutriPoints[nutriScore?.toLowerCase()] || 25;
  const novaPoints = { 1: 20, 2: 15, 3: 10, 4: 0 };
  const novaPts = novaPoints[parseInt(novaGroup)] ?? 10;
  const additivePts = Math.max(0, 20 - ((additivesCount || 0) * 5));
  const organicPts = isOrganic ? 10 : 0;
  const proteinPts = (protein && protein >= 10) ? 5 : 0;
  // Sugar penalty: per 100g, >22.5g is "high" by UK FSA standard
  const sugarPenalty = sugar >= 22.5 ? 10 : sugar >= 5 ? 5 : 0;
  // Sodium penalty: per 100g, >0.6g (600mg) is "high" by UK FSA standard
  const sodiumPenalty = sodium >= 0.6 ? 10 : sodium >= 0.3 ? 5 : 0;
  const rawScore = nutriPts + novaPts + additivePts + organicPts + proteinPts - sugarPenalty - sodiumPenalty;
  return Math.max(0, Math.min(100, Math.round(rawScore)));
}

const additiveMap = {'e100':'Curcumin','e101':'Riboflavin','e102':'Tartrazine','e104':'Quinoline Yellow','e110':'Sunset Yellow','e120':'Carmine','e122':'Carmoisine','e123':'Amaranth','e124':'Ponceau 4R','e127':'Erythrosine','e129':'Allura Red','e131':'Patent Blue','e132':'Indigo Carmine','e133':'Brilliant Blue','e140':'Chlorophyll','e150a':'Caramel Color','e150b':'Caustic Sulfite Caramel','e150c':'Ammonia Caramel','e150d':'Sulfite Ammonia Caramel','e153':'Vegetable Carbon','e160a':'Beta-Carotene','e160b':'Annatto','e161b':'Lutein','e162':'Beetroot Red','e163':'Anthocyanins','e170':'Calcium Carbonate','e171':'Titanium Dioxide','e172':'Iron Oxides','e200':'Sorbic Acid','e202':'Potassium Sorbate','e210':'Benzoic Acid','e211':'Sodium Benzoate','e212':'Potassium Benzoate','e213':'Calcium Benzoate','e220':'Sulfur Dioxide','e221':'Sodium Sulfite','e222':'Sodium Bisulfite','e223':'Sodium Metabisulfite','e224':'Potassium Metabisulfite','e249':'Potassium Nitrite','e250':'Sodium Nitrite','e251':'Sodium Nitrate','e252':'Potassium Nitrate','e260':'Acetic Acid','e261':'Potassium Acetate','e262':'Sodium Acetate','e270':'Lactic Acid','e280':'Propionic Acid','e281':'Sodium Propionate','e282':'Calcium Propionate','e283':'Potassium Propionate','e290':'Carbon Dioxide','e296':'Malic Acid','e297':'Fumaric Acid','e300':'Vitamin C','e301':'Sodium Ascorbate','e302':'Calcium Ascorbate','e306':'Vitamin E','e307':'Alpha-Tocopherol','e310':'Propyl Gallate','e311':'Octyl Gallate','e312':'Dodecyl Gallate','e319':'TBHQ','e320':'BHA','e321':'BHT','e322':'Lecithin','e330':'Citric Acid','e331':'Sodium Citrate','e332':'Potassium Citrate','e333':'Calcium Citrate','e334':'Tartaric Acid','e335':'Sodium Tartrate','e336':'Potassium Tartrate','e337':'Sodium Potassium Tartrate','e338':'Phosphoric Acid','e339':'Sodium Phosphate','e340':'Potassium Phosphate','e341':'Calcium Phosphate','e343':'Magnesium Phosphate','e350':'Sodium Malate','e351':'Potassium Malate','e352':'Calcium Malate','e353':'Metatartaric Acid','e380':'Triammonium Citrate','e400':'Alginic Acid','e401':'Sodium Alginate','e402':'Potassium Alginate','e403':'Ammonium Alginate','e404':'Calcium Alginate','e405':'Propylene Glycol Alginate','e406':'Agar','e407':'Carrageenan','e410':'Locust Bean Gum','e412':'Guar Gum','e413':'Tragacanth','e414':'Acacia Gum','e415':'Xanthan Gum','e416':'Karaya Gum','e417':'Tara Gum','e418':'Gellan Gum','e420':'Sorbitol','e421':'Mannitol','e422':'Glycerol','e432':'Polysorbate 20','e433':'Polysorbate 80','e440':'Pectin','e442':'Ammonium Phosphatides','e450':'Diphosphates','e451':'Triphosphates','e452':'Polyphosphates','e460':'Cellulose','e461':'Methyl Cellulose','e462':'Ethyl Cellulose','e463':'Hydroxypropyl Cellulose','e464':'Hydroxypropyl Methyl Cellulose','e465':'Methyl Ethyl Cellulose','e466':'Carboxymethyl Cellulose','e470':'Fatty Acid Salts','e471':'Mono and Diglycerides','e472a':'Acetic Acid Esters','e472b':'Lactic Acid Esters','e472c':'Citric Acid Esters','e472e':'Diacetyl Tartaric Esters','e473':'Sucrose Esters','e474':'Sucroglycerides','e475':'Polyglycerol Esters','e476':'Polyglycerol Polyricinoleate','e477':'Propylene Glycol Esters','e481':'Sodium Stearoyl Lactylate','e482':'Calcium Stearoyl Lactylate','e491':'Sorbitan Monostearate','e500':'Sodium Carbonates','e501':'Potassium Carbonates','e503':'Ammonium Carbonates','e504':'Magnesium Carbonates','e507':'Hydrochloric Acid','e508':'Potassium Chloride','e509':'Calcium Chloride','e511':'Magnesium Chloride','e512':'Stannous Chloride','e514':'Sodium Sulfates','e515':'Potassium Sulfates','e516':'Calcium Sulfate','e524':'Sodium Hydroxide','e525':'Potassium Hydroxide','e526':'Calcium Hydroxide','e527':'Ammonium Hydroxide','e528':'Magnesium Hydroxide','e529':'Calcium Oxide','e530':'Magnesium Oxide','e535':'Sodium Ferrocyanide','e536':'Potassium Ferrocyanide','e538':'Calcium Ferrocyanide','e541':'Sodium Aluminum Phosphate','e551':'Silicon Dioxide','e552':'Calcium Silicate','e553a':'Magnesium Silicate','e553b':'Talc','e554':'Sodium Aluminosilicate','e555':'Potassium Aluminum Silicate','e556':'Calcium Aluminosilicate','e558':'Bentonite','e559':'Aluminum Silicate','e570':'Fatty Acids','e574':'Gluconic Acid','e575':'Glucono Delta Lactone','e576':'Sodium Gluconate','e577':'Potassium Gluconate','e578':'Calcium Gluconate','e579':'Ferrous Gluconate','e585':'Ferrous Lactate','e620':'Glutamic Acid','e621':'MSG','e622':'Potassium Glutamate','e623':'Calcium Glutamate','e624':'Monoammonium Glutamate','e625':'Magnesium Glutamate','e626':'Guanylic Acid','e627':'Disodium Guanylate','e628':'Dipotassium Guanylate','e629':'Calcium Guanylate','e630':'Inosinic Acid','e631':'Disodium Inosinate','e632':'Dipotassium Inosinate','e633':'Calcium Inosinate','e635':'Disodium Ribonucleotides','e640':'Glycine','e650':'Zinc Acetate','e900':'Dimethyl Polysiloxane','e901':'Beeswax','e902':'Candelilla Wax','e903':'Carnauba Wax','e904':'Shellac','e905':'Microcrystalline Wax','e912':'Montan Acid Esters','e914':'Oxidized Polyethylene Wax','e920':'L-Cysteine','e927b':'Carbamide','e938':'Argon','e939':'Helium','e941':'Nitrogen','e942':'Nitrous Oxide','e943a':'Butane','e943b':'Isobutane','e944':'Propane','e948':'Oxygen','e949':'Hydrogen','e950':'Acesulfame K','e951':'Aspartame','e952':'Cyclamates','e953':'Isomalt','e954':'Saccharin','e955':'Sucralose','e957':'Thaumatin','e959':'Neohesperidin','e960':'Steviol Glycosides','e961':'Neotame','e962':'Aspartame-Acesulfame Salt','e965':'Maltitol','e966':'Lactitol','e967':'Xylitol','e968':'Erythritol','e999':'Quillaia Extract','e1103':'Invertase','e1200':'Polydextrose','e1201':'Polyvinylpyrrolidone','e1202':'Polyvinylpolypyrrolidone','e1404':'Oxidized Starch','e1410':'Monostarch Phosphate','e1412':'Distarch Phosphate','e1413':'Phosphated Distarch Phosphate','e1414':'Acetylated Distarch Phosphate','e1420':'Acetylated Starch','e1422':'Acetylated Distarch Adipate','e1440':'Hydroxypropyl Starch','e1442':'Hydroxypropyl Distarch Phosphate','e1450':'Starch Sodium Octenyl Succinate','e1451':'Acetylated Oxidized Starch'};

// Additive details: name, category, riskLevel (high/limited/safe), description
const additiveDetails = {
  'e102': { category: 'Artificial color', riskLevel: 'high', description: 'Yellow dye linked to hyperactivity in children. Banned in some countries, requires warning label in EU.' },
  'e104': { category: 'Artificial color', riskLevel: 'high', description: 'Yellow-green dye associated with hyperactivity in children. Banned in the US and Australia.' },
  'e110': { category: 'Artificial color', riskLevel: 'high', description: 'Orange dye linked to hyperactivity and allergic reactions. Requires warning label in the EU.' },
  'e120': { category: 'Natural color', riskLevel: 'limited', description: 'Red dye made from crushed insects. Generally safe but can cause allergic reactions in some people.' },
  'e122': { category: 'Artificial color', riskLevel: 'high', description: 'Red dye linked to hyperactivity in children. Banned in the US. Requires warning label in the EU.' },
  'e123': { category: 'Artificial color', riskLevel: 'high', description: 'Red dye banned in the US due to potential cancer risk. Still permitted in some countries.' },
  'e124': { category: 'Artificial color', riskLevel: 'high', description: 'Red dye linked to hyperactivity in children. Requires warning label in the EU.' },
  'e127': { category: 'Artificial color', riskLevel: 'high', description: 'Red dye that can affect thyroid function. Banned in the EU for most uses.' },
  'e129': { category: 'Artificial color', riskLevel: 'high', description: 'Red 40 dye. Linked to hyperactivity in children. One of the most common artificial dyes in US foods.' },
  'e131': { category: 'Artificial color', riskLevel: 'high', description: 'Blue dye banned in the US and some other countries due to potential cancer risk.' },
  'e132': { category: 'Artificial color', riskLevel: 'limited', description: 'Blue dye that can cause allergic reactions. Limited evidence of risk at normal consumption levels.' },
  'e133': { category: 'Artificial color', riskLevel: 'limited', description: 'Blue 1 dye. May cause allergic reactions. Banned in some European countries.' },
  'e150a': { category: 'Color', riskLevel: 'safe', description: 'Plain caramel color made by heating sugar. No known health concerns at typical food levels.' },
  'e150c': { category: 'Color', riskLevel: 'limited', description: 'Ammonia caramel used in colas and dark beverages. May contain trace compounds of concern in very high amounts.' },
  'e150d': { category: 'Color', riskLevel: 'limited', description: 'Sulfite ammonia caramel found in colas. Contains 4-MEI, a compound flagged by some health agencies at high doses.' },
  'e160b': { category: 'Natural color', riskLevel: 'limited', description: 'Orange-yellow color from annatto seeds. Can trigger allergic reactions or hives in sensitive individuals.' },
  'e171': { category: 'Color / coating', riskLevel: 'high', description: 'Titanium dioxide used for whiteness. Banned in the EU as a food additive due to potential DNA damage concerns.' },
  'e200': { category: 'Preservative', riskLevel: 'safe', description: 'Sorbic acid naturally found in berries. Prevents mold and yeast. Generally recognized as safe.' },
  'e202': { category: 'Preservative', riskLevel: 'safe', description: 'Potassium salt of sorbic acid. Common preservative in cheese, wine, and baked goods. Generally safe.' },
  'e210': { category: 'Preservative', riskLevel: 'high', description: 'Benzoic acid can combine with Vitamin C in drinks to form benzene, a known carcinogen. Linked to hyperactivity.' },
  'e211': { category: 'Preservative', riskLevel: 'high', description: 'Sodium benzoate can react with Vitamin C to form benzene. Linked to hyperactivity in children.' },
  'e220': { category: 'Preservative', riskLevel: 'limited', description: 'Sulfur dioxide used in dried fruits and wine. Can trigger asthma and allergic reactions in sensitive people.' },
  'e221': { category: 'Preservative', riskLevel: 'limited', description: 'Sulfite preservative. Can cause asthmatic reactions. People with sulfite sensitivity should avoid it.' },
  'e223': { category: 'Preservative', riskLevel: 'limited', description: 'Sulfite preservative used in seafood and wine. Can trigger asthma and allergic reactions.' },
  'e249': { category: 'Preservative', riskLevel: 'high', description: 'Nitrite used to cure meats. Can form nitrosamines in the body, which are linked to colorectal cancer.' },
  'e250': { category: 'Preservative', riskLevel: 'high', description: 'Sodium nitrite in cured meats can form cancer-linked nitrosamines. Classified as a probable carcinogen by WHO.' },
  'e251': { category: 'Preservative', riskLevel: 'high', description: 'Sodium nitrate converts to nitrite in the body. Linked to increased colorectal cancer risk.' },
  'e252': { category: 'Preservative', riskLevel: 'high', description: 'Potassium nitrate used in cured meats. Converts to nitrite in the body, a probable carcinogen.' },
  'e282': { category: 'Preservative', riskLevel: 'limited', description: 'Calcium propionate prevents mold in bread. Some studies link it to irritability and sleep issues in children.' },
  'e310': { category: 'Antioxidant', riskLevel: 'limited', description: 'Propyl gallate prevents fat from going rancid. May cause allergic reactions and stomach irritation.' },
  'e319': { category: 'Antioxidant', riskLevel: 'limited', description: 'TBHQ preserves fats and oils. High doses linked to vision disturbances. Banned in Japan.' },
  'e320': { category: 'Antioxidant', riskLevel: 'limited', description: 'BHA prevents rancidity. Classified as possibly carcinogenic by some health agencies. Banned in some countries.' },
  'e321': { category: 'Antioxidant', riskLevel: 'limited', description: 'BHT prevents fat oxidation. Some animal studies raised cancer concerns. Banned in some countries.' },
  'e322': { category: 'Emulsifier', riskLevel: 'safe', description: 'Lecithin is a natural emulsifier from soy or sunflower. Widely considered safe. May cause issues for soy-allergic people.' },
  'e330': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Citric acid found naturally in citrus fruits. Widely used and considered safe at normal food levels.' },
  'e338': { category: 'Acidity regulator', riskLevel: 'limited', description: 'Phosphoric acid gives colas their tang. High intake linked to lower bone density and kidney issues.' },
  'e407': { category: 'Thickener', riskLevel: 'limited', description: 'Carrageenan is extracted from red seaweed. Some research links it to gut inflammation and digestive issues.' },
  'e420': { category: 'Sweetener', riskLevel: 'safe', description: 'Sorbitol is a sugar alcohol found naturally in fruits. Can cause bloating and diarrhea in large amounts.' },
  'e421': { category: 'Sweetener', riskLevel: 'safe', description: 'Mannitol is a sugar alcohol. Can cause bloating and diarrhea if consumed in large quantities.' },
  'e432': { category: 'Emulsifier', riskLevel: 'limited', description: 'Polysorbate 20 helps mix oil and water. Animal studies suggest it may disrupt gut bacteria at high doses.' },
  'e433': { category: 'Emulsifier', riskLevel: 'limited', description: 'Polysorbate 80 is a common emulsifier. Some studies suggest it may affect gut microbiome and promote inflammation.' },
  'e450': { category: 'Raising agent', riskLevel: 'limited', description: 'Diphosphates are phosphate salts used in baking powder. High phosphate intake may affect kidney function.' },
  'e451': { category: 'Raising agent', riskLevel: 'limited', description: 'Triphosphates used in processed meats and seafood. High phosphate intake linked to cardiovascular and kidney risk.' },
  'e452': { category: 'Stabilizer', riskLevel: 'limited', description: 'Polyphosphates keep moisture in processed meats. High intake may contribute to kidney stress.' },
  'e471': { category: 'Emulsifier', riskLevel: 'safe', description: 'Mono and diglycerides of fatty acids are common emulsifiers. Generally considered safe.' },
  'e476': { category: 'Emulsifier', riskLevel: 'safe', description: 'PGPR reduces viscosity in chocolate. Used to replace cocoa butter. Generally considered safe.' },
  'e551': { category: 'Anticaking agent', riskLevel: 'high', description: 'Silicon dioxide may contain nanoparticles capable of crossing the intestinal barrier. Linked to gut inflammation in some studies.' },
  'e554': { category: 'Anticaking agent', riskLevel: 'limited', description: 'Sodium aluminosilicate prevents clumping in powders. Aluminum content raises questions though absorption is low.' },
  'e621': { category: 'Flavor enhancer', riskLevel: 'limited', description: 'MSG enhances savory flavor. Generally recognized as safe, though some people report sensitivity symptoms.' },
  'e627': { category: 'Flavor enhancer', riskLevel: 'limited', description: 'Disodium guanylate amplifies flavor, often used with MSG. People with gout should avoid it.' },
  'e631': { category: 'Flavor enhancer', riskLevel: 'limited', description: 'Disodium inosinate enhances savory taste. Often paired with MSG. Not suitable for people with gout.' },
  'e635': { category: 'Flavor enhancer', riskLevel: 'limited', description: 'Ribonucleotides intensify flavor. Can trigger reactions in aspirin-sensitive individuals. Not suitable for gout sufferers.' },
  'e900': { category: 'Antifoaming agent', riskLevel: 'safe', description: 'Dimethyl polysiloxane (silicone) prevents foaming in cooking oils. Generally considered safe.' },
  'e950': { category: 'Sweetener', riskLevel: 'limited', description: 'Acesulfame K is 200x sweeter than sugar. Some animal studies raised concerns; results in humans are mixed.' },
  'e951': { category: 'Sweetener', riskLevel: 'limited', description: 'Aspartame is one of the most studied food additives. WHO classified it as possibly carcinogenic in 2023. Avoid with PKU.' },
  'e952': { category: 'Sweetener', riskLevel: 'high', description: 'Cyclamate is banned in the US due to cancer concerns in animal studies. Still permitted in some other countries.' },
  'e954': { category: 'Sweetener', riskLevel: 'limited', description: 'Saccharin was once suspected of causing cancer but is now considered safe at normal levels by most agencies.' },
  'e955': { category: 'Sweetener', riskLevel: 'limited', description: 'Sucralose is made from sugar but not metabolized. Some studies suggest it may affect gut bacteria and insulin response.' },
  'e960': { category: 'Sweetener', riskLevel: 'safe', description: 'Steviol glycosides are derived from the stevia plant. Considered safe and natural with no known health risks.' },
  'e965': { category: 'Sweetener', riskLevel: 'safe', description: 'Maltitol is a sugar alcohol used in sugar-free products. Can cause bloating and laxative effects in large amounts.' },
  'e967': { category: 'Sweetener', riskLevel: 'safe', description: 'Xylitol is a natural sugar alcohol. Safe for humans but extremely toxic to dogs. Can cause digestive discomfort.' },
  'e968': { category: 'Sweetener', riskLevel: 'safe', description: 'Erythritol is a sugar alcohol with nearly zero calories. Well tolerated and considered safe. May have heart benefits.' },
  'e1200': { category: 'Bulking agent', riskLevel: 'safe', description: 'Polydextrose is a synthetic fiber used to add bulk. Generally safe and may have mild prebiotic benefits.' },
  'e100': { category: 'Natural color', riskLevel: 'safe', description: 'Curcumin is the yellow pigment from turmeric. Widely used natural coloring with no known health risks.' },
  'e101': { category: 'Color / vitamin', riskLevel: 'safe', description: 'Riboflavin (vitamin B2) used as a yellow-orange color. Naturally occurring and considered safe.' },
  'e140': { category: 'Natural color', riskLevel: 'safe', description: 'Chlorophyll gives green color, extracted from plants. Considered safe with no known health risks.' },
  'e160a': { category: 'Natural color', riskLevel: 'safe', description: 'Beta-carotene is a natural orange pigment also found in carrots. Considered safe and a source of vitamin A.' },
  'e161b': { category: 'Natural color', riskLevel: 'safe', description: 'Lutein is a natural yellow pigment found in leafy greens. Considered safe and beneficial for eye health.' },
  'e162': { category: 'Natural color', riskLevel: 'safe', description: 'Beetroot red is a natural pigment from beets. Considered safe with no known health risks.' },
  'e163': { category: 'Natural color', riskLevel: 'safe', description: 'Anthocyanins are natural purple-red pigments from berries and grapes. Considered safe and antioxidant-rich.' },
  'e170': { category: 'Color / acidity regulator', riskLevel: 'safe', description: 'Calcium carbonate is a natural mineral used as a whitener and calcium source. Considered safe.' },
  'e172': { category: 'Color', riskLevel: 'safe', description: 'Iron oxides give brown, red, or black coloring. Naturally occurring mineral pigments considered safe.' },
  'e260': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Acetic acid is the acid found in vinegar. Widely used and considered completely safe.' },
  'e261': { category: 'Preservative', riskLevel: 'safe', description: 'Potassium acetate is a mild preservative and acidity regulator. Generally recognized as safe.' },
  'e262': { category: 'Preservative', riskLevel: 'safe', description: 'Sodium acetate is used as a preservative and flavoring. Generally recognized as safe.' },
  'e270': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Lactic acid occurs naturally in fermented foods like yogurt. Considered safe with no known health risks.' },
  'e280': { category: 'Preservative', riskLevel: 'safe', description: 'Propionic acid prevents mold in bread. Naturally found in some foods and generally considered safe.' },
  'e281': { category: 'Preservative', riskLevel: 'safe', description: 'Sodium propionate prevents mold growth in baked goods. Generally recognized as safe.' },
  'e296': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Malic acid gives a tart flavor, naturally found in apples. Considered safe.' },
  'e297': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Fumaric acid is a mild acidity regulator. Naturally occurring and considered safe.' },
  'e300': { category: 'Antioxidant / vitamin', riskLevel: 'safe', description: 'Vitamin C (ascorbic acid) is a natural antioxidant. Beneficial and considered completely safe.' },
  'e301': { category: 'Antioxidant', riskLevel: 'safe', description: 'Sodium ascorbate is a form of vitamin C used as an antioxidant. Considered completely safe.' },
  'e306': { category: 'Antioxidant / vitamin', riskLevel: 'safe', description: 'Vitamin E (tocopherol) is a natural antioxidant. Beneficial and considered completely safe.' },
  'e331': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Sodium citrate is a mild acidity regulator derived from citric acid. Considered safe.' },
  'e332': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Potassium citrate is a mild acidity regulator. Considered safe and sometimes used as an electrolyte source.' },
  'e333': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Calcium citrate is used as an acidity regulator and calcium source. Considered safe.' },
  'e334': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Tartaric acid gives a tart flavor, naturally found in grapes. Considered safe.' },
  'e339': { category: 'Acidity regulator', riskLevel: 'limited', description: 'Sodium phosphate regulates acidity and texture. High phosphate intake may affect kidney function over time.' },
  'e340': { category: 'Acidity regulator', riskLevel: 'limited', description: 'Potassium phosphate regulates acidity. High phosphate intake may affect kidney function over time.' },
  'e341': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Calcium phosphate is used as a firming agent and calcium source. Considered safe.' },
  'e406': { category: 'Thickener', riskLevel: 'safe', description: 'Agar is a natural gelling agent from seaweed. Considered safe and used as a vegetarian gelatin substitute.' },
  'e410': { category: 'Thickener', riskLevel: 'safe', description: 'Locust bean gum is a natural thickener from carob seeds. Considered safe.' },
  'e412': { category: 'Thickener', riskLevel: 'safe', description: 'Guar gum is a natural thickener from guar beans. Considered safe, though high amounts may cause bloating.' },
  'e414': { category: 'Thickener', riskLevel: 'safe', description: 'Acacia gum (gum arabic) is a natural thickener from acacia trees. Considered safe.' },
  'e415': { category: 'Thickener', riskLevel: 'safe', description: 'Xanthan gum is a fermentation-derived thickener. Widely used and considered safe.' },
  'e440': { category: 'Thickener', riskLevel: 'safe', description: 'Pectin is a natural thickener from fruit. Considered safe and commonly used in jams.' },
  'e460': { category: 'Thickener', riskLevel: 'safe', description: 'Cellulose is plant fiber used as a thickener or anti-caking agent. Considered safe.' },
  'e466': { category: 'Thickener', riskLevel: 'safe', description: 'Carboxymethyl cellulose thickens and stabilizes texture. Considered safe at typical food levels.' },
  'e500': { category: 'Raising agent', riskLevel: 'safe', description: 'Sodium carbonates (baking soda family) are used as raising agents. Considered safe.' },
  'e501': { category: 'Raising agent', riskLevel: 'safe', description: 'Potassium carbonates are used as raising agents and acidity regulators. Considered safe.' },
  'e503': { category: 'Raising agent', riskLevel: 'safe', description: 'Ammonium carbonates are used as raising agents in baked goods. Considered safe.' },
  'e508': { category: 'Flavor enhancer', riskLevel: 'safe', description: 'Potassium chloride is a salt substitute. Considered safe though high amounts may affect those with kidney issues.' },
  'e509': { category: 'Firming agent', riskLevel: 'safe', description: 'Calcium chloride is used as a firming agent in canned vegetables and cheese. Considered safe.' },
  'e574': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Gluconic acid is a mild organic acid. Considered safe and naturally occurring.' },
  'e575': { category: 'Acidity regulator', riskLevel: 'safe', description: 'Glucono delta-lactone is a mild acidifier used in meats and baked goods. Considered safe.' },
  'e640': { category: 'Flavor enhancer', riskLevel: 'safe', description: 'Glycine is an amino acid used as a flavor enhancer. Considered safe and naturally occurring.' },
  'e901': { category: 'Glazing agent', riskLevel: 'safe', description: 'Beeswax is a natural glazing agent for candies and fruit. Considered safe.' },
  'e903': { category: 'Glazing agent', riskLevel: 'safe', description: 'Carnauba wax is a natural plant-based glazing agent. Considered safe.' },
  'e953': { category: 'Sweetener', riskLevel: 'safe', description: 'Isomalt is a sugar alcohol with low calorie impact. Can cause bloating in large amounts but generally safe.' },
  'e966': { category: 'Sweetener', riskLevel: 'safe', description: 'Lactitol is a sugar alcohol used as a sweetener and fiber source. May cause digestive discomfort in large amounts.' },
};

app.get('/scan/:barcode', async (req, res) => {
  try {
    const { barcode } = req.params;
    const offRes = await fetch(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`);
    const offData = await offRes.json();
    const product = offData.product;
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const productName = product.product_name || 'Unknown Product';
    const imageUrl = product.image_front_url || '';
    const ingredients = product.ingredients_text || '';
    const nutriScore = product.nutriscore_grade || 'c';
    const novaGroup = product.nova_group || 3;
    const additivesCount = product.additives_n || 0;

    const additiveTags = product.additives_tags || [];

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
      };
    });

    const isOrganic = product.labels_tags?.includes('en:organic') || false;
    const protein = product.nutriments?.proteins_100g || 0;
    const sugar = product.nutriments?.sugars_100g || 0;
    const sodium = product.nutriments?.sodium_100g || 0;
    const score = calculateScore(nutriScore, novaGroup, additivesCount, isOrganic, protein, sugar, sodium);

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
        messages: [{ role: 'user', content: `Food ingredients: ${ingredients}. In one plain English sentence (max 20 words), explain the main health concern or benefit for a regular consumer.` }]
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
      ingredients: ingredients.substring(0, 150) + (ingredients.length > 150 ? '...' : ''),
      nutriScore,
      novaGroup,
      additivesCount: additivesCount === 0 ? 'None' : additivesCount + ' additives',
      isOrganic: isOrganic ? 'Yes' : 'No',
      protein: protein + 'g',
      sugar: sugar + 'g',
      sodium: sodium + 'g',
      score,
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
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
