import { LightningElement, track, api } from 'lwc';
import askEinstein from '@salesforce/apex/B2BCommerceOrderMatrixController.askEinstein';

export default class B2bAiAssistant extends LightningElement {
    
    @api products = [];

    // --- MEMOIRE CONTEXTUELLE DES RECOMMANDATIONS ---
    activeRecommendations = []; 
    // ------------------------------------------------

    @track messages = [
        { 
            id: 'welcome', 
            text: "Hello! I'm your B2B Sales Assistant. How can I help you today?", 
            isAi: true,
            wrapperClass: 'message-wrapper left', 
            bubbleClass: 'chat-bubble left' 
        }
    ];
    @track userInput = '';
    @track isTyping = false;
    
    conversationContext = ''; 

    handleInputChange(event) { this.userInput = event.target.value; }
    handleKeyUp(event) { if (event.key === 'Enter') this.handleSend(); }

    // --- LOGIQUE IA-DRIVEN (System Prompt) ---
    @api async triggerAiRecommendation(addedItemName, recommendedItems) {
        this.isTyping = true; 

        // 1. Sauvegarde dans le contexte actif de l'assistant
        this.activeRecommendations = recommendedItems || [];

        const systemPrompt = `SYSTEM_CONTEXT: The user successfully added "${addedItemName}" to their cart. 
        Based on this, the system recommends these specific Cross-Sell products: 
        ${JSON.stringify(recommendedItems)}. 
        INSTRUCTION: Inform the user that the item was added, then suggest these recommendations naturally using the provided data.`;

        // Note: On passe le catalogue, mais le prompt système donne les détails spécifiques des recos
        const contextString = JSON.stringify(this.products); 

        try {
            const result = await askEinstein({ 
                userMessage: systemPrompt, 
                productContextString: contextString
            });

            this.isTyping = false;

            if (result.success) {
                const aiData = JSON.parse(result.response);
                
                let cardsToDisplay = [];
                if (aiData.items) {
                    cardsToDisplay = aiData.items.map(item => {
                        const fullData = recommendedItems.find(r => r.sku === item.sku) || 
                                         this.products.find(p => (p.sku === item.sku || p.StockKeepingUnit === item.sku));
                        
                        if (fullData) {
                            return {
                                id: fullData.id,
                                name: fullData.name,
                                sku: fullData.sku || fullData.StockKeepingUnit,
                                price: fullData.displayUnitPrice || fullData.unitPrice || fullData.price,
                                imgUrl: fullData.imgUrl,
                                promo: fullData.promoName || fullData.promo,
                                currency: 'USD'
                            };
                        }
                        return null;
                    }).filter(x => x !== null);
                }

                this.messages = [...this.messages, {
                    id: Date.now(),
                    text: aiData.message, 
                    isAi: true,
                    products: cardsToDisplay.length > 0 ? cardsToDisplay : null,
                    wrapperClass: 'message-wrapper left',
                    bubbleClass: 'chat-bubble left'
                }];
                
                this.conversationContext += `\nAssistant: ${aiData.message}`;
                this.scrollToBottom();
            }
        } catch (e) {
            this.isTyping = false;
            console.error('AI Trigger Error', e);
        }
    }

    async handleSend() {
        if (!this.userInput.trim()) return;

        const text = this.userInput;
        this.addMessage(text, false);
        this.conversationContext += `\nUser: ${text}`;
        
        this.userInput = '';
        this.isTyping = true;
        this.scrollToBottom();

        // 1. Préparation du Contexte PRINCIPAL (Grille)
        const contextData = this.products.map(p => {
            let tierInfo = '';
            if (p.tierList && p.tierList.length > 0) {
                tierInfo = p.tierList.map(t => t.label).join(', ');
            }
            
            const sellingPrice = p.displayUnitPrice || p.unitPrice; 
            let standardPrice = p.displayListPrice;
            if (!standardPrice && sellingPrice !== p.unitPrice) { standardPrice = p.unitPrice; }
            let stockVal = 'Unlimited';
            if (p.stock !== undefined && p.stock !== null && p.stock !== '') { stockVal = p.stock; }
            let enrichedDesc = p.Description || '';
            if (p.variationInfo) { enrichedDesc += ` (${p.variationInfo})`; }

            return {
                name: p.name,
                sku: p.sku || p.StockKeepingUnit, 
                desc: enrichedDesc, 
                price: sellingPrice,       
                listPrice: standardPrice,  
                promo: p.promoName || '',  
                stock: stockVal,             
                selected: p.qtyValue || 0,   
                inCart: p.cartQty || 0,      
                min: p.minQty || 1,
                max: p.maxQty || '',
                inc: p.increment || 1,
                tiers: tierInfo
            };
        });

        // 2. FUSION : Ajouter les Recos Actives au contexte avec PRIORITÉ
        if (this.activeRecommendations.length > 0) {
            console.log('🕵️ [DEBUG AI] Injection des Recos dans le contexte JSON...');
            
            // On inverse l'ordre pour les mettre EN PREMIER (unshift)
            [...this.activeRecommendations].reverse().forEach(reco => {
                const existsIndex = contextData.findIndex(c => c.sku === reco.sku);
                
                let newItem = {
                    name: reco.name,
                    sku: reco.sku,
                    // --- TAG SPECIAL POUR L'IA (CASE 5) ---
                    desc: "(Recommended) " + (reco.variationInfo || "Cross-Sell Product"), 
                    // -------------------------------------
                    price: reco.displayUnitPrice || reco.price,
                    stock: 'Available',
                    selected: 0,
                    inCart: 0
                };

                if (existsIndex !== -1) {
                    // Si existe déjà, on le déplace en haut et on update la desc
                    let existing = contextData[existsIndex];
                    existing.desc = "(Recommended) " + existing.desc;
                    contextData.splice(existsIndex, 1); // Retirer de l'ancienne position
                    contextData.unshift(existing);      // Mettre en haut
                } else {
                    // Si nouveau, on ajoute en haut
                    contextData.unshift(newItem);
                }
            });
        }

        const contextString = JSON.stringify(contextData); 
        console.log('🕵️ [DEBUG AI] JSON envoyé:', contextString);

        try {
            const result = await askEinstein({ 
                userMessage: this.conversationContext,
                productContextString: contextString
            });
            
            this.isTyping = false;

            if (result.success) {
                try {
                    const aiData = JSON.parse(result.response);
                    this.conversationContext += `\nAssistant: ${aiData.message}`;

                    let productsToDisplay = [];
                    
                    if (aiData.items && Array.isArray(aiData.items)) {
                        aiData.items.forEach(item => {
                            // 3. RECHERCHE ETENDUE (Grille OU Recos)
                            let foundProduct = this.products.find(p => 
                                (p.sku === item.sku) || (p.StockKeepingUnit === item.sku)
                            );

                            // Si pas dans la grille, check dans les recos actives
                            if (!foundProduct && this.activeRecommendations.length > 0) {
                                foundProduct = this.activeRecommendations.find(r => r.sku === item.sku);
                                if (foundProduct) {
                                    // Mapping rapide pour uniformiser
                                    foundProduct = {
                                        ...foundProduct,
                                        qtyValue: 0, 
                                        StockKeepingUnit: foundProduct.sku 
                                    };
                                }
                            }

                            if (foundProduct) {
                                let finalQty = 0;
                                let qtyRaw = item.quantity ? parseInt(item.quantity, 10) : 0;

                                console.log(`🤖 Action IA pour ${item.sku}: ${item.action} (Qté: ${qtyRaw})`);

                                if (item.action === 'set') {
                                    const currentSelected = foundProduct.qtyValue ? parseFloat(foundProduct.qtyValue) : 0;
                                    finalQty = qtyRaw - currentSelected;
                                } 
                                else if (item.action === 'remove') {
                                    finalQty = -qtyRaw;
                                }
                                else {
                                    finalQty = qtyRaw;
                                }

                                // --- MODIFICATION : CHECK IS RECO ---
                                const isFromReco = this.activeRecommendations.some(r => r.sku === item.sku);
                                // ------------------------------------

                                if (finalQty !== 0 && item.action !== 'search') {
                                    this.dispatchEvent(new CustomEvent('addproduct', {
                                        detail: { 
                                            sku: foundProduct.sku || foundProduct.StockKeepingUnit, 
                                            quantity: finalQty,
                                            isRecommendation: isFromReco // On passe l'info au parent
                                        }
                                    }));
                                }
                                
                                productsToDisplay.push({
                                    id: foundProduct.id,
                                    name: foundProduct.name,
                                    sku: foundProduct.sku || foundProduct.StockKeepingUnit,
                                    price: foundProduct.displayUnitPrice || foundProduct.price,
                                    imgUrl: foundProduct.imgUrl,
                                    promo: foundProduct.promoName,
                                    currency: 'USD'
                                });
                            }
                        });
                    }
                    this.addMessage(aiData.message, true, productsToDisplay);

                } catch (jsonError) {
                    console.error('JSON Parse Error:', jsonError);
                    this.addMessage(result.response, true);
                    this.conversationContext += `\nAssistant: ${result.response}`;
                }

            } else {
                this.addMessage("⚠️ " + result.message, true);
            }

        } catch (error) {
            this.isTyping = false;
            console.error('LWC Error:', error);
            this.addMessage("Sorry, connection error.", true);
        }

        this.scrollToBottom();
    }

    addMessage(text, isAi, products = null) {
        let productCards = [];
        
        if (products) {
            const list = Array.isArray(products) ? products : [products];
            
            productCards = list.map(p => {
                const sellingPrice = p.displayUnitPrice || p.unitPrice;
                let standardPrice = p.displayListPrice;
                if (!standardPrice && sellingPrice !== p.unitPrice) {
                    standardPrice = p.unitPrice;
                }

                let specsArray = [];
                if (p.variationInfo) {
                    specsArray = p.variationInfo.split(', '); 
                }

                return {
                    id: p.id,
                    name: p.name,
                    sku: p.sku || p.StockKeepingUnit,
                    price: sellingPrice,
                    imgUrl: p.imgUrl,
                    promo: p.promoName,
                    listPrice: standardPrice, 
                    currency: p.currencyCode || 'USD',
                    specs: specsArray 
                };
            });
        }

        this.messages = [...this.messages, {
            id: Date.now(),
            text: text,
            isAi: isAi,
            products: productCards.length > 0 ? productCards : null,
            wrapperClass: `message-wrapper ${isAi ? 'left' : 'right'}`,
            bubbleClass: `chat-bubble ${isAi ? 'left' : 'right'}`
        }];
    }

    scrollToBottom() {
        setTimeout(() => {
            const chatBox = this.template.querySelector('.chat-messages');
            if (chatBox) chatBox.scrollTop = chatBox.scrollHeight;
        }, 50);
    }

    handleAddRequest(event) {
        const sku = event.target.dataset.sku;
        const qty = parseInt(event.target.dataset.qty, 10);
        this.dispatchEvent(new CustomEvent('addproduct', {
            detail: { sku: sku, quantity: qty }
        }));
    }
}