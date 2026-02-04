import { LightningElement, wire, api, track } from 'lwc';
import { AppContextAdapter, SessionContextAdapter } from 'commerce/contextApi';
import { CartSummaryAdapter, refreshCartSummary } from 'commerce/cartApi';
import { getPromotionPricingCollection } from 'commerce/promotionApi';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { resolve } from 'experience/resourceResolver';

import getAllActiveProducts from '@salesforce/apex/B2BCommerceOrderMatrixController.getAllActiveProducts'; 
import getPastOrders from '@salesforce/apex/B2BCommerceOrderMatrixController.getPastOrders';
import getOrderProducts from '@salesforce/apex/B2BCommerceOrderMatrixController.getOrderProducts';
import getCartQuantities from '@salesforce/apex/B2BCommerceOrderMatrixController.getCartQuantities';
import addItemsToCart from '@salesforce/apex/B2BCommerceOrderMatrixController.addItemsToCart';
import communityId from '@salesforce/community/Id';
import communityBasePath from '@salesforce/community/basePath'; // AJOUT IMPORT

const SOURCE_CATALOG = 'catalog';

/**
 * @description Composant principal B2B Order Matrix.
 * Affiche une grille de commande rapide avec calcul dynamique des prix (paliers, promos),
 * gestion du stock et intégration avec le panier LWR.
 */
export default class B2bCommerceOrderMatrix extends LightningElement {
    static renderMode = 'light';
    
    @api lowStockThreshold = 10;
    @api showStockQuantity = false;

    @track products = [];
    @track isLoading = true;
    @track isSaving = false;
    @track error = null;

    inputQty = {}; 
    cartDataMap = {}; 
    promoDataMap = {};
    
    // Caches
    masterCatalogData = []; 
    rawProductData = [];
    orderItemsCache = {}; 
    
    searchTerm = ''; 
    webstoreId;
    effectiveAccountId;
    activeCartId;
    _isPreview = false;

    // Gestion d'état
    currentSourceValue = SOURCE_CATALOG;
    @track pastOrdersList = []; 

    selectedOrderId = null;
    fromDate = null;
    toDate = null;

    // --- GETTERS ---
    get productCount() { return this.products ? this.products.length : 0; }
    get totalItemsToAdd() { let t = 0; Object.values(this.inputQty).forEach(v => t += parseFloat(v)); return t; }
    get hasErrors() { return this.products.some(p => p.isError && p.qtyValue && p.qtyValue !== '0'); }
    get isAddToCartDisabled() { return this.totalItemsToAdd === 0 || this.isSaving || this.hasErrors; }

    get sourceOptions() {
        const options = [
            { label: 'All Products (Full Catalog)', value: SOURCE_CATALOG }
        ];
        if (this.pastOrdersList && this.pastOrdersList.length > 0) {
            this.pastOrdersList.forEach(order => {
                const orderName = `Order ${order.orderNumber}`;
                const boldName = this.toBold(orderName);
                const details = `${order.orderedDate}  •  ${order.grandTotalAmount} ${order.currencyIsoCode}`;
                options.push({ label: `${boldName}   •   ${details}`, value: order.id });
            });
        }
        return options;
    }

    /**
     * @description Convertit une chaîne de caractères en caractères Unicode gras mathématiques pour le style des options.
     */
    toBold(text) {
        const diffDigit = 0x1D7CE - 48;
        const diffUpper = 0x1D400 - 65;
        const diffLower = 0x1D41A - 97;
        return text.split('').map(char => {
            const n = char.charCodeAt(0);
            if (n >= 48 && n <= 57) return String.fromCodePoint(n + diffDigit);
            if (n >= 65 && n <= 90) return String.fromCodePoint(n + diffUpper);
            if (n >= 97 && n <= 122) return String.fromCodePoint(n + diffLower);
            return char; 
        }).join('');
    }

    /**
     * @description Lifecycle hook.
     */
    connectedCallback() { console.log('🚀 [LWC] Component Initialized'); }

    @wire(AppContextAdapter) wiredAppContext({ data }) { if (data) { this.webstoreId = data.webstoreId; this.tryLoadData(); } }
    @wire(SessionContextAdapter) wiredSessionContext({ data }) { if (data) { this.effectiveAccountId = data.effectiveAccountId; this._isPreview = data.isPreview; this.tryLoadData(); } }
    @wire(CartSummaryAdapter) wiredCartSummary({ data }) { if (data) { this.activeCartId = data.cartId; if (this.rawProductData.length > 0) this.fetchCartDataAndRebuild(true); } }

    /**
     * @description Vérifie si le contexte (store, account) est prêt avant de lancer le chargement des données.
     */
    tryLoadData() { if (this.webstoreId && this.effectiveAccountId) { this.loadData(); } }

    /**
     * @description Orchestre le chargement initial : historique des commandes en arrière-plan et catalogue produit au premier plan.
     */
    async loadData() {
        this.error = null;
        this.loadPastOrdersBackground();
        if (this.masterCatalogData.length > 0) {
            this.rawProductData = [...this.masterCatalogData];
            this.inputQty = {}; 
            this.searchTerm = '';
            this.buildGrid();
            this.isLoading = false;
        } else {
            await this.loadCatalogProducts();
        }
    }

    /**
     * @description Charge l'historique des commandes via Apex sans bloquer l'interface utilisateur.
     * Met en cache les items des commandes pour une réutilisation rapide.
     */
    async loadPastOrdersBackground() {
        try {
            const result = await getPastOrders({ effectiveAccountId: this.effectiveAccountId, fromDate: null, toDate: null });
            this.pastOrdersList = result.orders || [];
            const allItems = result.allItems || [];
            this.orderItemsCache = {}; 
            allItems.forEach(item => {
                if (!this.orderItemsCache[item.orderId]) this.orderItemsCache[item.orderId] = [];
                this.orderItemsCache[item.orderId].push({ productId: item.productId, quantity: item.quantity });
            });
        } catch (e) { console.warn('Error loading past orders in background', e); }
    }

    /**
     * @description Charge la totalité des produits actifs du catalogue via Apex.
     * Trie les résultats par nom.
     */
    async loadCatalogProducts() {
        this.isLoading = true;
        try {
            const result = await getAllActiveProducts({ communityId: communityId, effectiveAccountId: this.effectiveAccountId });
            
            console.log('🔥 [APEX] Retour complet de getAllActiveProducts :', result);

            if (result.error) { 
                this.error = result.error; 
                console.error('❌ Erreur retournée par Apex :', result.error);
            } 
            else {
                const unsortedProducts = result.products || [];
                
                if (unsortedProducts.length > 0) {
                    console.log('📦 [PRODUIT 1] Structure brute :', unsortedProducts[0]);
                    console.log('🔑 [CHAMPS DISPOS] :', Object.keys(unsortedProducts[0]));
                } else {
                    console.warn('⚠️ Aucun produit trouvé dans le catalogue.');
                }

                unsortedProducts.sort((a, b) => {
                    const nameA = (a.name || '').toLowerCase();
                    const nameB = (b.name || '').toLowerCase();
                    return nameA.localeCompare(nameB);
                });

                this.masterCatalogData = unsortedProducts;
                this.rawProductData = [...this.masterCatalogData];
                
                if (this.rawProductData.length > 0) { 
                    await this.fetchCartDataAndRebuild(false); 
                    this.fetchPromotions(); 
                } 
                else { 
                    this.buildGrid(); 
                }
            }
        } catch (error) { 
            this.error = 'Unable to load products.'; 
            console.error('❌ JS Exception :', error); 
        } 
        finally { 
            this.isLoading = false; 
        }
    }

    /**
     * @description Gère le changement de source (Catalogue complet vs Commande passée).
     */
    handleSourceChange(event) {
        const newValue = event.detail.value;
        this.currentSourceValue = newValue;
        this.inputQty = {}; 
        this.searchTerm = ''; 
        if (newValue === SOURCE_CATALOG) {
            this.rawProductData = [...this.masterCatalogData];
            this.buildGrid();
        } else {
            this.loadOrderProducts(newValue);
        }
    }

    /**
     * @description Charge les produits d'une commande spécifique. 
     * Utilise le cache local si disponible, sinon appelle Apex.
     */
    async loadOrderProducts(orderId) {
        if (!orderId) return;
        if (this.masterCatalogData.length === 0) { this.isLoading = true; await this.loadCatalogProducts(); }
        const cachedItems = this.orderItemsCache[orderId];
        if (cachedItems) {
            this.inputQty = {};
            const orderItemIds = new Set();
            cachedItems.forEach(item => {
                this.inputQty[item.productId] = item.quantity.toString();
                orderItemIds.add(item.productId);
            });
            this.rawProductData = this.masterCatalogData.filter(p => orderItemIds.has(p.id));
            this.rawProductData.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            if (this.rawProductData.length > 0) { 
                this.fetchCartDataAndRebuild(true); 
                if (Object.keys(this.promoDataMap).length === 0) this.fetchPromotions();
                else this.buildGrid();
            } else { this.buildGrid(); }
            return;
        }
        this.isLoading = true;
        try {
            const result = await getOrderProducts({ communityId: communityId, effectiveAccountId: this.effectiveAccountId, orderSummaryId: orderId, skipEnrichment: true });
             const orderItemIds = new Set();
             if(result.orderQuantities) {
                 result.orderQuantities.forEach(qty => {
                     this.inputQty[qty.productId] = qty.quantity.toString();
                     orderItemIds.add(qty.productId);
                 });
             }
             this.rawProductData = this.masterCatalogData.filter(p => orderItemIds.has(p.id));
             this.buildGrid();
        } catch (error) { this.error = 'Unable to load order products.'; } 
        finally { this.isLoading = false; }
    }

    // --- GRID BUILD ---

    /**
     * @description Construit la structure de données pour la grille UI en fusionnant :
     * 1. Données produits (rawProductData)
     * 2. Saisies utilisateur (inputQty)
     * 3. État du panier (cartDataMap)
     * 4. Promotions (promoDataMap)
     * Applique également les filtres de recherche.
     */
    buildGrid() {
        const term = this.searchTerm ? this.searchTerm.toLowerCase() : '';
        const filteredData = this.rawProductData.filter(p => {
            return (p.name || '').toLowerCase().includes(term) || (p.sku || '').toLowerCase().includes(term);
        });

        this.products = filteredData.map(prod => {
            const pId = prod.id;
            const currentInputStr = this.inputQty[pId] || '0';
            const currentInputVal = parseFloat(currentInputStr);
            const inCart = parseFloat(this.cartDataMap[pId] || 0);
            const promoData = this.promoDataMap[pId] || {};
            
            const min = prod.minQty ? parseFloat(prod.minQty) : 1;
            const max = prod.maxQty ? parseFloat(prod.maxQty) : 999999;
            const inc = prod.increment ? parseFloat(prod.increment) : 1;
            const isInfiniteStock = (prod.stock === undefined || prod.stock === null || prod.stock === 'null');
            const physicalStock = isInfiniteStock ? 999999 : parseFloat(prod.stock);

            let hasError = false;
            if (currentInputVal > Math.max(0, physicalStock - inCart)) { hasError = true; }
            if (currentInputVal > 0) {
                if (currentInputVal < min) hasError = true;
                if (max && currentInputVal > max) hasError = true;
                const ratio = currentInputVal / inc;
                if (Math.abs(ratio - Math.round(ratio)) > 0.0001) { hasError = true; }
            }

            const stockState = this.calculateStockState(physicalStock, inCart, currentInputVal, isInfiniteStock);
            const priceCalc = this.calculateFinalPrice(prod, (currentInputVal || 1) + inCart, promoData.price);
            const finalLimit = Math.min(Math.max(0, max - inCart), Math.max(0, physicalStock - inCart));

            let specsList = null;
            if (prod.variationInfo) {
                specsList = prod.variationInfo.split(', ').map(spec => {
                    return { key: spec, label: spec, cssClass: 'spec-pill' };
                });
            }

            return {
                ...prod, 
                id: pId,
                imgUrl: prod.imgUrl ? resolve(prod.imgUrl) : null,
                qtyValue: currentInputStr === '0' ? '' : currentInputStr,
                cartQty: inCart > 0 ? inCart : null,
                min, max, inc, finalLimit, 
                isError: hasError, 
                displayUnitPrice: priceCalc.unitPrice,
                displayListPrice: priceCalc.listPrice,
                showListPrice: priceCalc.showListPrice,
                priceClass: priceCalc.priceClass,
                promoName: promoData.name || null,
                stockLabel: stockState.label,
                stockClass: stockState.cssClass,
                tierList: this.generateDynamicTiers(prod, (currentInputVal || 1) + inCart, promoData.price),
                ruleList: this.generateRuleItems({ minQty: min, maxQty: max, increment: inc }, currentInputVal, inCart),
                specsList: specsList,
                inputClass: hasError ? 'qty-input-field has-error' : 'qty-input-field',
                productUrl: communityBasePath + '/product/' + pId // URL MODIFIEE AVEC BASE PATH
            };
        });
    }

   // --- ECOUTE EVENEMENT CHAT IA ---

    /**
     * @description Écouteur d'événement pour les actions déclenchées par l'assistant IA.
     * Met à jour les quantités d'input (inputQty) basé sur les intentions "Add/Remove/Set".
     */
    handleAiAddProduct(event) {
        const { sku, quantity } = event.detail;
        
        const productFound = this.rawProductData.find(p => 
            (p.sku && p.sku === sku) || (p.StockKeepingUnit && p.StockKeepingUnit === sku)
        );

        if (productFound) {
            const pId = productFound.id;
            const currentQty = parseFloat(this.inputQty[pId] || 0);
            
            const rawNewQty = currentQty + quantity;
            const newQty = Math.max(0, rawNewQty); 

            if (newQty === 0) {
                delete this.inputQty[pId];
            } else {
                this.inputQty[pId] = String(newQty);
            }

            this.buildGrid(); 
            
            if (quantity !== 0) {
                this.showToast('Updated', `${productFound.name}: ${newQty} units.`, 'success');
            }
        } else {
            this.showToast('Warning', `Product with SKU ${sku} is not in the current list view.`, 'warning');
        }
    }

    // --- HELPERS ---

    /**
     * @description Récupère les prix promotionnels via l'API Commerce Promotion.
     */
    async fetchPromotions() {
        if (!this.rawProductData || !this.webstoreId) return;
        const productIdsInput = this.rawProductData.map(p => ({ productId: p.id }));
        try {
            const result = await getPromotionPricingCollection({ webstoreId: this.webstoreId, effectiveAccountId: this.effectiveAccountId, products: productIdsInput });
            if (result?.promotionProductEvaluationResults) {
                const newPromoMap = { ...this.promoDataMap };
                result.promotionProductEvaluationResults.forEach(item => {
                    const info = { price: parseFloat(item.promotionalPrice) || null };
                    if (item.promotionPriceAdjustmentList?.[0]?.displayName) info.name = item.promotionPriceAdjustmentList[0].displayName;
                    else if (item.promotionPriceAdjustmentList?.[0]?.adjustmentValue) info.name = 'Promotion';
                    if (info.name || info.price !== null) newPromoMap[item.productId] = info;
                });
                this.promoDataMap = newPromoMap;
                this.buildGrid();
            }
        } catch (e) { console.warn('Promo fetch failed', e); }
    }

    /**
     * @description Met à jour les quantités présentes dans le panier actif pour les produits affichés.
     */
    async fetchCartDataAndRebuild(silentMode = false) {
        if (!this.rawProductData.length) return;
        if (!silentMode) this.isLoading = true;
        try {
            const cartResult = await getCartQuantities({ communityId, effectiveAccountId: this.effectiveAccountId, productIds: this.rawProductData.map(p => p.id), activeCartId: this.activeCartId });
            this.cartDataMap = cartResult || {};
            this.buildGrid();
        } catch (e) { this.buildGrid(); } 
        finally { if (!silentMode) this.isLoading = false; }
    }
    
    handleSearchChange(event) { this.searchTerm = event.target.value; this.buildGrid(); }

    /**
     * @description Génère les badges de règles (Min, Max, Incrément) pour l'affichage.
     */
    generateRuleItems(details, currentInputQty, currentCartQty) {
        const rules = [];
        const total = currentInputQty + currentCartQty;
        if (details.minQty > 1) rules.push({ key: 'min', label: `Min ${parseFloat(details.minQty)}`, cssClass: 'rule-item' });
        if (details.maxQty && details.maxQty < 999999) rules.push({ key: 'max', label: `Max ${parseFloat(details.maxQty)}`, cssClass: (total >= details.maxQty ? 'rule-item rule-reached' : 'rule-item') });
        if (details.increment > 1) rules.push({ key: 'inc', label: `Inc ${parseFloat(details.increment)}`, cssClass: 'rule-item' });
        return rules.length ? rules : null;
    }

    /**
     * @description Calcule l'état visuel du stock (In Stock / Low Stock / Out of Stock).
     */
    calculateStockState(physicalStock, currentInCart, currentInput, isInfiniteStock) {
        let remaining = physicalStock - currentInCart - currentInput;
        if (remaining < 0) remaining = 0;
        const showConfig = (this.showStockQuantity === true || String(this.showStockQuantity) === 'true');
        const showNumber = showConfig && !isInfiniteStock;
        const qtySuffix = showNumber ? `: ${remaining.toFixed(0)}` : '';
        let label = '';
        let cssClass = 'slds-badge';
        if (remaining <= 0) { label = 'Out of Stock'; cssClass += ' slds-theme_error'; } 
        else if (remaining <= this.lowStockThreshold && !isInfiniteStock) { label = `Low Stock${qtySuffix}`; cssClass += ' slds-theme_warning'; } 
        else { label = `In Stock${qtySuffix}`; cssClass += ' slds-theme_success'; }
        return { label, cssClass };
    }

    /**
     * @description Calcule le prix final unitaire à afficher en fonction des paliers (Price Tiers) et des promotions.
     */
    calculateFinalPrice(details, quantity, promoPrice) {
        let basePrice = parseFloat(details.unitPrice);
        let currentPrice = basePrice;
        let isPromo = false;
        const tiers = details.priceRanges || [];
        if (tiers.length > 0 && quantity > 0) {
            const tier = tiers.filter(t => quantity >= t.min).sort((a, b) => b.min - a.min)[0];
            if (tier) currentPrice = parseFloat(tier.price);
        }
        if (promoPrice != null && !isNaN(promoPrice) && basePrice > 0) {
            if (promoPrice < basePrice) {
                const discountRatio = promoPrice / basePrice;
                currentPrice = currentPrice * discountRatio;
                isPromo = true;
            }
        }
        let listPrice = details.listPrice ? parseFloat(details.listPrice) : basePrice; 
        let roundedCurrent = Math.round(currentPrice * 100) / 100;
        let showList = (listPrice > roundedCurrent);
        return { 
            unitPrice: currentPrice.toFixed(2), 
            listPrice: listPrice.toFixed(2), 
            showListPrice: showList, 
            priceClass: 'slds-text-body_regular ' + (isPromo ? 'price-promo' : 'slds-text-title_bold')
        };
    }

    /**
     * @description Génère la liste des paliers de prix pour affichage visuel, en appliquant le ratio de promotion si nécessaire.
     */
    generateDynamicTiers(details, quantity, promoPrice) {
        if (!details.priceRanges?.length) return null;
        let discountRatio = 1.0;
        let basePrice = parseFloat(details.unitPrice);
        if (promoPrice != null && !isNaN(promoPrice) && basePrice > 0) { if (promoPrice < basePrice) discountRatio = promoPrice / basePrice; }
        const activeTier = details.priceRanges.filter(t => quantity >= t.min).sort((a, b) => b.min - a.min)[0];
        return details.priceRanges.map(t => {
            let finalTierPrice = parseFloat(t.price) * discountRatio;
            return {
                key: t.min, 
                label: `${t.max ? t.min + '-' + t.max : t.min + '+'} @ ${finalTierPrice.toFixed(2)}`, 
                cssClass: (activeTier && activeTier.min === t.min) ? 'tier-pill tier-active' : 'tier-pill'
            };
        });
    }

    handleIncrement(event) {
        const prodId = event.currentTarget.dataset.id;
        const prod = this.products.find(p => p.id === prodId);
        if (!prod) return;
        const currentVal = parseFloat(this.inputQty[prodId] || 0);
        let newVal;
        if (currentVal < prod.min) { newVal = prod.min; } 
        else { newVal = (Math.floor(currentVal / prod.inc) + 1) * prod.inc; }
        if (prod.max && newVal > prod.max) { if (currentVal < prod.max) newVal = prod.max; else return; }
        this.updateQty(prodId, newVal);
    }

    handleDecrement(event) {
        const prodId = event.currentTarget.dataset.id;
        const prod = this.products.find(p => p.id === prodId);
        if (!prod) return;
        const currentVal = parseFloat(this.inputQty[prodId] || 0);
        let newVal = (Math.ceil(currentVal / prod.inc) - 1) * prod.inc;
        if (newVal < prod.min) { newVal = 0; }
        this.updateQty(prodId, newVal);
    }

    handleQtyChange(event) {
        const prodId = event.target.dataset.id;
        let val = parseFloat(event.target.value);
        if (isNaN(val)) val = 0;
        this.updateQty(prodId, val);
    }

    updateQty(prodId, rawVal) {
        let newVal = rawVal < 0 ? 0 : rawVal;
        if (newVal === 0) delete this.inputQty[prodId];
        else this.inputQty[prodId] = String(newVal);
        this.buildGrid();
    }

    /**
     * @description Ajoute les produits sélectionnés au panier.
     * Vérifie les erreurs (stocks, règles) avant d'appeler l'Apex.
     * Déclenche un rafraîchissement du mini-cart LWR.
     */
    async handleAddToCart() {
        if (this._isPreview || this.isSaving) return;
        this.isSaving = true;
        const hasItems = Object.values(this.inputQty).some(val => val && parseFloat(val) > 0);
        
        if (this.hasErrors) {
            this.showToast('Error', 'Please correct invalid quantities (red fields).', 'error');
            this.isSaving = false;
            return;
        }

        if (!hasItems) { this.showToast('Warning', 'Please select at least one item.', 'warning'); this.isSaving = false; return; }
        
        try {
            const itemsMap = {};
            for (const [pId, qtyStr] of Object.entries(this.inputQty)) { const qty = parseFloat(qtyStr); if (qty > 0) itemsMap[pId] = qty; }
            await addItemsToCart({ communityId: communityId, effectiveAccountId: this.effectiveAccountId, itemsMap: itemsMap });
            for (const [pId, qty] of Object.entries(itemsMap)) { this.cartDataMap[pId] = (parseFloat(this.cartDataMap[pId] || 0) + qty); }
            this.inputQty = {};
            this.buildGrid(); 
            this.showToast('Success', 'Items added to cart.', 'success');
            await refreshCartSummary();
            this.dispatchEvent(new CustomEvent('cartchanged'));
        } catch (error) { this.showToast('Error', error.body?.message || 'Error adding to cart.', 'error'); this.fetchCartDataAndRebuild(false); } 
        finally { this.isSaving = false; }
    }

    showToast(title, message, variant) { this.dispatchEvent(new ShowToastEvent({ title, message, variant })); }
}