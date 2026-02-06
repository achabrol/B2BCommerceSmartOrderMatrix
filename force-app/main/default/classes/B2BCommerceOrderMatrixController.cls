/**
 * @description Contrôleur B2B Order Matrix
 * VERSION : Standard (Expand) + File Analysis + Adjustment Explanations
 * Filtre strict pour exclure les champs techniques "External ID" des variations.
 * Intègre les appels aux APIs Commerce et ajoute le support de la mémoire contextuelle pour Einstein.
 */
public without sharing class B2BCommerceOrderMatrixController {

    // ------------------------------------------------------------------------
    // 1. CATALOGUE
    // ------------------------------------------------------------------------

    /**
     * @description Récupère tous les produits actifs du catalogue associés au WebStore.
     * @param communityId L'ID du réseau (Community/Site).
     * @param effectiveAccountId L'ID du compte effectif.
     * @return Map<String, Object> Contient la liste des produits enrichis et le webstoreId.
     */
    @AuraEnabled
    public static Map<String, Object> getAllActiveProducts(String communityId, String effectiveAccountId) {
        String webstoreId = resolveWebstoreId(communityId);
        String accountId = String.isNotBlank(effectiveAccountId) ? effectiveAccountId : null;
        
        Map<String, Object> responseMap = new Map<String, Object>();
        responseMap.put('webstoreId', webstoreId);

        if (String.isBlank(webstoreId)) {
            responseMap.put('error', 'WebStore ID not found.');
            return responseMap;
        }

        String catalogId = getCatalogId(webstoreId);
        Set<String> rootCategoryIds = new Set<String>();
        
        if (String.isNotBlank(catalogId)) {
            for (ProductCategory r : [SELECT Id FROM ProductCategory WHERE CatalogId = :catalogId AND ParentCategoryId = null]) {
                rootCategoryIds.add(r.Id);
            }
        }

        if (rootCategoryIds.isEmpty()) {
            responseMap.put('products', new List<Map<String, Object>>());
            return responseMap;
        }

        Map<String, ConnectApi.ProductSummary> uniqueProductMap = new Map<String, ConnectApi.ProductSummary>();
        
        try {
            for (String catId : rootCategoryIds) {
                Integer pageNumber = 0; 
                Boolean hasMore = true;
                
                while(hasMore) {
                    ConnectApi.ProductSearchInput input = new ConnectApi.ProductSearchInput();
                    input.categoryId = catId;
                    input.pageSize = 200; 
                    input.page = pageNumber;
                    input.includeQuantityRule = true;
                    input.fields = new List<String>{'StockKeepingUnit', 'Description'};

                    ConnectApi.ProductSearchResults results = ConnectApi.CommerceSearch.searchProducts(webstoreId, accountId, input);
                    
                    if (results?.productsPage?.products != null) {
                        for (ConnectApi.ProductSummary ps : results.productsPage.products) {
                            if (!uniqueProductMap.containsKey(ps.id) && ps.productClass != ConnectApi.ProductClass.VariationParent) {
                                uniqueProductMap.put(ps.id, ps);
                            }
                        }
                        
                        if (results.productsPage.products.size() < input.pageSize) {
                            hasMore = false; 
                        } else {
                            pageNumber++;
                            if (pageNumber > 20) {
                                hasMore = false; 
                            }
                        }
                    } else {
                        hasMore = false;
                    }
                }
            }
        } catch (Exception e) { 
            System.debug('Search Error: ' + e.getMessage()); 
        }

        return buildResponseFromSummaries(uniqueProductMap.values(), webstoreId, accountId);
    }

    // ------------------------------------------------------------------------
    // 2. PAST ORDERS
    // ------------------------------------------------------------------------

    /**
     * @description Récupère l'historique des commandes (OrderSummary).
     * @param effectiveAccountId L'ID du compte.
     * @param fromDateStr Date de début.
     * @param toDateStr Date de fin.
     * @return Map<String, Object> Liste des commandes et items plats.
     */
    @AuraEnabled
    public static Map<String, Object> getPastOrders(String effectiveAccountId, String fromDateStr, String toDateStr) {
        Date fromDate = String.isNotBlank(fromDateStr) ? Date.valueOf(fromDateStr) : null;
        Date toDate = String.isNotBlank(toDateStr) ? Date.valueOf(toDateStr) : null;
        
        String query = 'SELECT Id, OrderNumber, OrderedDate, GrandTotalAmount, Status, CurrencyIsoCode FROM OrderSummary WHERE AccountId = :effectiveAccountId ';
        if (fromDate != null) query += 'AND OrderedDate >= :fromDate ';
        if (toDate != null) query += 'AND OrderedDate <= :toDate ';
        query += 'ORDER BY OrderedDate DESC LIMIT 100';

        List<OrderSummary> orders = Database.query(query);
        List<Map<String, Object>> orderList = new List<Map<String, Object>>();
        Set<Id> orderIds = new Set<Id>();
        
        for (OrderSummary ord : orders) {
            orderIds.add(ord.Id);
            orderList.add(new Map<String, Object>{ 
                'id' => ord.Id, 
                'orderNumber' => ord.OrderNumber, 
                'orderedDate' => ord.OrderedDate.format('yyyy-MM-dd HH:mm'), 
                'grandTotalAmount' => ord.GrandTotalAmount, 
                'status' => ord.Status, 
                'currencyIsoCode' => ord.CurrencyIsoCode 
            });
        }

        List<Map<String, Object>> allItemsList = new List<Map<String, Object>>();
        if (!orderIds.isEmpty()) {
            List<OrderItemSummary> allItems = [SELECT OrderSummaryId, Product2Id, Quantity FROM OrderItemSummary WHERE OrderSummaryId IN :orderIds AND Product2Id != null AND Type != 'Delivery Charge' AND OriginalOrderItem.ParentOrderItemId = null];
            for(OrderItemSummary item : allItems) { 
                allItemsList.add(new Map<String, Object>{ 
                    'orderId' => item.OrderSummaryId, 
                    'productId' => item.Product2Id, 
                    'quantity' => item.Quantity 
                }); 
            }
        }
        return new Map<String, Object>{ 'orders' => orderList, 'allItems' => allItemsList };
    }

    // ------------------------------------------------------------------------
    // 3. ORDER PRODUCTS
    // ------------------------------------------------------------------------

    /**
     * @description Récupère les détails des produits d'une commande passée.
     * @param communityId ID du réseau.
     * @param effectiveAccountId ID du compte.
     * @param orderSummaryId ID de la commande.
     * @param skipEnrichment Si true, saute l'appel Search (plus rapide).
     * @return Map<String, Object> Produits et quantités.
     */
    @AuraEnabled
    public static Map<String, Object> getOrderProducts(String communityId, String effectiveAccountId, String orderSummaryId, Boolean skipEnrichment) {
        String webstoreId = resolveWebstoreId(communityId);
        String accountId = String.isNotBlank(effectiveAccountId) ? effectiveAccountId : null;

        Map<String, Object> responseMap = new Map<String, Object>();
        responseMap.put('products', new List<Map<String, Object>>()); 
        responseMap.put('orderQuantities', new List<Map<String, Object>>());
        
        if (String.isBlank(webstoreId)) {
            return responseMap;
        }

        List<OrderItemSummary> orderItems = [SELECT Product2Id, Quantity FROM OrderItemSummary WHERE OrderSummaryId = :orderSummaryId AND Product2Id != null AND Type != 'Delivery Charge' AND OriginalOrderItem.ParentOrderItemId = null];
        
        if (orderItems.isEmpty()) {
            return responseMap;
        }

        Set<String> validProductIds = new Set<String>();
        List<Map<String, Object>> quantitiesList = new List<Map<String, Object>>();
        
        for (OrderItemSummary oi : orderItems) { 
            validProductIds.add(oi.Product2Id); 
            quantitiesList.add(new Map<String, Object>{ 
                'productId' => oi.Product2Id, 
                'quantity' => oi.Quantity 
            }); 
        }
        responseMap.put('orderQuantities', quantitiesList);

        if (skipEnrichment == true) {
            return responseMap; 
        }

        List<Product2> dbProducts = [SELECT Id, StockKeepingUnit FROM Product2 WHERE Id IN :validProductIds];
        List<String> skusToSearch = new List<String>();
        for(Product2 p : dbProducts) { 
            if(String.isNotBlank(p.StockKeepingUnit) && p.StockKeepingUnit != '999999') {
                skusToSearch.add(p.StockKeepingUnit); 
            }
        }

        Map<String, ConnectApi.ProductSummary> summaryMap = new Map<String, ConnectApi.ProductSummary>();
        
        if(!skusToSearch.isEmpty()) {
            try {
                ConnectApi.ProductSearchInput input = new ConnectApi.ProductSearchInput();
                input.searchTerm = String.join(skusToSearch, ' '); 
                input.pageSize = 100; 
                input.includeQuantityRule = true; 
                input.fields = new List<String>{'StockKeepingUnit', 'Description'};
                
                ConnectApi.ProductSearchResults results = ConnectApi.CommerceSearch.searchProducts(webstoreId, accountId, input);
                
                if (results?.productsPage?.products != null) { 
                    for (ConnectApi.ProductSummary ps : results.productsPage.products) { 
                        if (validProductIds.contains(ps.id)) {
                            summaryMap.put(ps.id, ps); 
                        }
                    } 
                }
            } catch(Exception e) {
                System.debug('Error enriching products: ' + e.getMessage());
            }
        }
        
        Map<String, Object> builtData = buildResponseFromSummaries(summaryMap.values(), webstoreId, accountId);
        responseMap.put('products', builtData.get('products'));
        return responseMap;
    }

    // ------------------------------------------------------------------------
    // 4. HELPER PRINCIPAL (BUILDER)
    // ------------------------------------------------------------------------

    /**
     * @description Transforme ProductSummary en format LWC enrichi (Prix, Stock, Variations).
     */
    private static Map<String, Object> buildResponseFromSummaries(List<ConnectApi.ProductSummary> summaries, String webstoreId, String accountId) {
        Map<String, Object> responseMap = new Map<String, Object>();
        if (summaries == null || summaries.isEmpty()) {
            responseMap.put('products', new List<Map<String, Object>>());
            return responseMap;
        }

        Set<String> skus = new Set<String>();
        Set<String> variationProductIds = new Set<String>();

        for(ConnectApi.ProductSummary ps : summaries) {
            String sku = null;
            if (ps.fields != null && ps.fields.containsKey('StockKeepingUnit')) {
                sku = (String) ps.fields.get('StockKeepingUnit').value;
            }
            if(String.isNotBlank(sku)) {
                skus.add(sku);
            }

            if (ps.productClass == ConnectApi.ProductClass.Variation) {
                variationProductIds.add(ps.id);
            }
        }
        
        Map<String, String> ociStockMap = getOCIStockMap(webstoreId, skus);
        Map<String, String> variationAttributesMap = getVariationInfoMapDynamic(variationProductIds);

        List<Map<String, Object>> resultList = new List<Map<String, Object>>();

        for (ConnectApi.ProductSummary ps : summaries) {
            Map<String, Object> d = new Map<String, Object>();
            d.put('id', ps.id);
            d.put('name', ps.name);
            d.put('imgUrl', (ps.defaultImage != null) ? ps.defaultImage.url : '');
            
            String sku = '';
            String description = '';
            if (ps.fields != null) {
                if (ps.fields.containsKey('StockKeepingUnit')) {
                    sku = (String) ps.fields.get('StockKeepingUnit').value;
                }
                if (ps.fields.containsKey('Description')) {
                    description = (String) ps.fields.get('Description').value;
                } else if (ps.fields.containsKey('description')) { 
                    description = (String) ps.fields.get('description').value;
                }
            }
            d.put('sku', sku);
            d.put('Description', description);
            
            d.put('variationInfo', variationAttributesMap.containsKey(ps.id) ? variationAttributesMap.get(ps.id) : '');

            d.put('unitPrice', 0); 
            d.put('listPrice', 0); 
            d.put('currencyCode', 'USD'); 
            d.put('priceRanges', new List<Map<String, Object>>());
            d.put('stock', (String.isNotBlank(sku) && ociStockMap.containsKey(sku)) ? ociStockMap.get(sku) : null);

            try {
                ConnectApi.ProductPrice priceData = ConnectApi.CommerceStorePricing.getProductPrice(webstoreId, ps.id, accountId);
                if (priceData != null) {
                    d.put('unitPrice', priceData.unitPrice); 
                    d.put('listPrice', priceData.listPrice); 
                    d.put('currencyCode', priceData.currencyIsoCode);
                    
                    if (priceData.priceAdjustment?.priceAdjustmentTiers != null) {
                        List<Map<String, Object>> ranges = new List<Map<String, Object>>();
                        for (ConnectApi.PriceAdjustmentTier tier : priceData.priceAdjustment.priceAdjustmentTiers) {
                            ranges.add(new Map<String, Object>{ 'min' => tier.lowerBound, 'price' => tier.tierUnitPrice });
                        }
                        d.put('priceRanges', ranges);
                    }
                }
            } catch (Exception e) {
                // Ignore pricing errors gracefully
            }

            Object rawMin = (ps.purchaseQuantityRule != null) ? ps.purchaseQuantityRule.minimum : null;
            d.put('minQty', (rawMin != null) ? Decimal.valueOf(String.valueOf(rawMin)) : 1);
            
            Object rawMax = (ps.purchaseQuantityRule != null) ? ps.purchaseQuantityRule.maximum : null;
            d.put('maxQty', (rawMax != null) ? Decimal.valueOf(String.valueOf(rawMax)) : null);
            
            Object rawInc = (ps.purchaseQuantityRule != null) ? ps.purchaseQuantityRule.increment : null;
            d.put('increment', (rawInc != null) ? Decimal.valueOf(String.valueOf(rawInc)) : 1);

            resultList.add(d);
        }
        responseMap.put('products', resultList);
        return responseMap;
    }

    // ------------------------------------------------------------------------
    // 5. SCANNER DYNAMIQUE (VARIATIONS)
    // ------------------------------------------------------------------------

    /**
     * @description Récupère les attributs de variation en ignorant les "External ID".
     */
    private static Map<String, String> getVariationInfoMapDynamic(Set<String> productIds) {
        Map<String, String> results = new Map<String, String>();
        if (productIds.isEmpty()) return results;
        
        Map<String, Schema.SObjectField> fieldMap = Schema.SObjectType.ProductAttribute.fields.getMap();
        List<String> variationFields = new List<String>();
        
        for (String fieldName : fieldMap.keySet()) {
            Schema.DescribeFieldResult dfr = fieldMap.get(fieldName).getDescribe();
            if (dfr.isCustom()) {
                String label = dfr.getLabel();
                if (!label.containsIgnoreCase('External ID')) {
                    variationFields.add(dfr.getName());
                }
            }
        }
        
        if (variationFields.isEmpty()) return results;
        
        String query = 'SELECT ProductId, ' + String.join(variationFields, ', ') + ' FROM ProductAttribute WHERE ProductId IN :productIds';
        
        try {
            List<SObject> attributes = Database.query(query);
            for (SObject attr : attributes) {
                String pId = (String) attr.get('ProductId');
                List<String> activeVars = new List<String>();
                for (String field : variationFields) {
                    try {
                        Object val = attr.get(field);
                        if (val != null) {
                            String label = fieldMap.get(field).getDescribe().getLabel();
                            if (!label.containsIgnoreCase('External ID')) {
                                activeVars.add(label + ': ' + String.valueOf(val));
                            }
                        }
                    } catch(Exception ex) {
                        // Ignore individual field errors
                    }
                }
                if (!activeVars.isEmpty()) {
                    results.put(pId, String.join(activeVars, ', '));
                }
            }
        } catch (Exception e) {
            System.debug('Error fetching variations: ' + e.getMessage());
        }
        return results;
    }
    
    // ------------------------------------------------------------------------
    // 6. ACTIONS CART
    // ------------------------------------------------------------------------

    /**
     * @description Ajoute une liste de produits au panier (crée le panier si inexistant).
     */
    @AuraEnabled
    public static void addItemsToCart(String communityId, String effectiveAccountId, Map<String, Double> itemsMap) {
        String webstoreId = resolveWebstoreId(communityId);
        ConnectApi.CartInput cartInput = new ConnectApi.CartInput();
        cartInput.effectiveAccountId = effectiveAccountId;
        String cartId;
        
        try {
            ConnectApi.CartSummary summary = ConnectApi.CommerceCart.getCartSummary(webstoreId, effectiveAccountId, 'active');
            cartId = summary.cartId;
        } catch(Exception e) {
            cartId = ConnectApi.CommerceCart.createCart(webstoreId, cartInput).cartId;
        }
        
        List<ConnectApi.BatchInput> batchInputs = new List<ConnectApi.BatchInput>();
        for (String productId : itemsMap.keySet()) {
            ConnectApi.CartItemInput item = new ConnectApi.CartItemInput();
            item.productId = productId;
            item.quantity = String.valueOf(itemsMap.get(productId));
            item.type = ConnectApi.CartItemType.PRODUCT;
            batchInputs.add(new ConnectApi.BatchInput(item));
        }
        
        if (!batchInputs.isEmpty()) { 
            ConnectApi.CommerceCart.addItemsToCart(webstoreId, effectiveAccountId, cartId, batchInputs); 
        }
    }

    /**
     * @description Récupère les quantités du panier actif pour une liste de produits.
     */
    @AuraEnabled
    public static Map<String, Decimal> getCartQuantities(String communityId, String effectiveAccountId, List<String> productIds, String activeCartId) {
        Map<String, Decimal> cartMap = new Map<String, Decimal>();
        if (String.isNotBlank(activeCartId)) {
            for(CartItem item : [SELECT Product2Id, Quantity FROM CartItem WHERE CartId = :activeCartId AND Product2Id IN :productIds]) { 
                cartMap.put(item.Product2Id, item.Quantity); 
            }
        }
        return cartMap;
    }

    // ------------------------------------------------------------------------
    // 7. OCI (Omnichannel Inventory)
    // ------------------------------------------------------------------------

    private static Map<String, String> getOCIStockMap(String webstoreId, Set<String> skus) {
        Map<String, String> stockMap = new Map<String, String>();
        if (skus.isEmpty()) return stockMap;
        
        try {
            Map<String, String> oci = resolveOCISource(webstoreId);
            if (oci.get('IsEnabled') == 'true') {
                ConnectApi.OCIGetInventoryAvailabilityInputRepresentation input = new ConnectApi.OCIGetInventoryAvailabilityInputRepresentation();
                input.stockKeepingUnits = new List<String>(skus);
                
                if (oci.get('Type') == 'Location') {
                    input.locationIdentifiers = new List<String>{ oci.get('Identifier') };
                } else {
                    input.locationGroupIdentifiers = new List<String>{ oci.get('Identifier') };
                }
                
                Object res = ConnectApi.OmnichannelInventoryService.getInventoryAvailability(input);
                Map<String, Object> resMap = (Map<String, Object>) JSON.deserializeUntyped(JSON.serialize(res));
                List<Object> allRecords = new List<Object>();
                
                if (resMap.containsKey('locations')) {
                    for(Object loc : (List<Object>)resMap.get('locations')) {
                        allRecords.addAll((List<Object>)((Map<String, Object>)loc).get('inventoryRecords'));
                    }
                } else if (resMap.containsKey('locationGroups')) {
                    for(Object grp : (List<Object>)resMap.get('locationGroups')) {
                        allRecords.addAll((List<Object>)((Map<String, Object>)grp).get('inventoryRecords'));
                    }
                }
                
                for(Object r : allRecords) { 
                    Map<String, Object> rec = (Map<String, Object>) r; 
                    stockMap.put((String)rec.get('stockKeepingUnit'), String.valueOf(rec.get('availableToFulfill'))); 
                }
            }
        } catch(Exception e) {
            System.debug('OCI Error: ' + e.getMessage());
        }
        return stockMap;
    }

    // ------------------------------------------------------------------------
    // 8. UTILITAIRES
    // ------------------------------------------------------------------------
    
    private static String getCatalogId(String webstoreId) {
        List<SObject> links = Database.query('SELECT ProductCatalogId FROM WebStoreCatalog WHERE SalesStoreId = :webstoreId LIMIT 1');
        if (links.isEmpty()) {
            links = Database.query('SELECT ProductCatalogId FROM WebStoreCatalog WHERE WebStoreId = :webstoreId LIMIT 1');
        }
        return links.isEmpty() ? null : (String) links[0].get('ProductCatalogId');
    }

    private static Map<String, String> resolveOCISource(String webstoreId) {
        Map<String, String> res = new Map<String, String>{ 'IsEnabled' => 'false' };
        List<WebStoreInventorySource> sources = [SELECT IsEnabled, LocationSourceId, LocationSource.Type FROM WebStoreInventorySource WHERE WebStoreId = :webstoreId LIMIT 1];
        
        if (!sources.isEmpty()) {
            res.put('IsEnabled', String.valueOf(sources[0].IsEnabled));
            res.put('Type', sources[0].LocationSource.Type);
            String sid = sources[0].LocationSourceId;
            String q = (sources[0].LocationSource.Type == 'Location') ? 'SELECT ExternalReference FROM Location WHERE Id = :sid' : 'SELECT ExternalReference FROM LocationGroup WHERE Id = :sid';
            List<SObject> locs = Database.query(q.replace(':sid', '\''+sid+'\''));
            if (!locs.isEmpty()) {
                res.put('Identifier', (String) locs[0].get('ExternalReference'));
            }
        }
        return res;
    }

    private static String resolveWebstoreId(String communityId) {
        try {
            List<WebStoreNetwork> wsn = [SELECT WebStoreId FROM WebStoreNetwork WHERE NetworkId = :communityId LIMIT 1];
            if (!wsn.isEmpty()) {
                return wsn[0].WebStoreId;
            }
        } catch (Exception e) {
            // Fallback for test context
        }
        
        if (!Test.isRunningTest()) {
            List<WebStore> stores = [SELECT Id FROM WebStore LIMIT 1];
            if (!stores.isEmpty()) {
                return stores[0].Id;
            }
        }
        return null;
    }

    // ------------------------------------------------------------------------
    // 9. EINSTEIN AI CHAT
    // ------------------------------------------------------------------------

    /**
     * @description Point d'entrée pour l'assistant IA.
     * Utilise ConnectApi.EinsteinLLM pour générer une réponse structurée (JSON).
     * @param userMessage Le message de l'utilisateur.
     * @param productContextString Le catalogue JSON.
     * @param lastShownContextString Les derniers produits vus/interagis (Mémoire court terme).
     * @param orderContext Le contexte de l'historique des commandes (JSON). -- NOUVEAU
     * @param userContext Contexte utilisateur (userName, language).
     * @return Map<String, Object> Réponse contenant le JSON généré par l'IA.
     */
    @AuraEnabled
    public static Map<String, Object> askEinstein(
        String userMessage, 
        String productContextString, 
        String lastShownContextString,
        String orderContext, // AJOUT PARAMETRE
        Map<String, Object> userContext 
    ) {
        Map<String, Object> result = new Map<String, Object>();
        
        // DEBUG LOGS (Server Side)
        System.debug('--- 🤖 AI REQUEST START ---');
        System.debug('User Message: ' + userMessage);
        
        try {
            String userName = 'User';
            String language = null;
            if (userContext != null) {
                if (userContext.containsKey('userName')) userName = (String)userContext.get('userName');
                if (userContext.containsKey('language')) language = (String)userContext.get('language');
            }

            ConnectApi.EinsteinLlmGenerationsInput generationsInput = new ConnectApi.EinsteinLlmGenerationsInput();
            
            String prompt = 'You are a friendly B2B Sales Assistant for user ' + userName + '.\n';
            if (String.isNotBlank(language)) {
                prompt += 'Current Communication Language: ' + language + '.\n';
            }
            prompt += 'You have access to CATALOG DATA (JSON) and RECENTLY SHOWN ITEMS.\n\n';
            
            prompt += '### CATALOG DATA:\n' + productContextString + '\n\n';
            
            // --- AJOUT LOGIQUE PROMPT ORDER CONTEXT ---
            if (String.isNotBlank(orderContext)) {
                prompt += '### ORDER HISTORY:\n' + orderContext + '\n\n';
            }
            // -------------------------------------------
            
            prompt += '### RECENTLY SHOWN ITEMS (MEMORY):\n' + (lastShownContextString != null ? lastShownContextString : '[]') + '\n\n';
            
            prompt += '### INSTRUCTIONS:\n';
            prompt += '1. VISUAL CARDS: If you recommend specific products, include them in the "items" array (action="search").\n';
            prompt += '2. TEXT MESSAGE: Keep it SHORT. No technical specs in text. Respond in the same language as the User Query or the provided Context Language.\n';
            // --- AJOUT INSTRUCTION ORDER ---
            prompt += '3. ORDERS: You can use ORDER HISTORY to answer questions about past orders, status, or reordering.\n';
            // --------------------------------
            prompt += '4. ACTIONS:\n';
            prompt += '   - "Add 5" -> action="add", quantity=5\n';
            prompt += '   - "Remove 2" -> action="remove", quantity=2\n';
            prompt += '   - "Set to 10" -> action="set", quantity=10\n';
            prompt += '   - "Add All" / "Everything" / "Max" -> action="set", quantity=9999999\n';
            prompt += '   - "Search/Show X" -> action="search"\n';
            
            // MODIFICATION CHIRURGICALE : Action pour détails commande
            prompt += '   - "Show Order Details" -> action="show_details", quantity=ORDERED_QTY\n';

            prompt += '5. OUTPUT FORMAT (JSON ONLY):\n';
            prompt += '   { \n';
            prompt += '     "message": "Short text summary in the target language", \n';
            prompt += '     "detectedLanguage": "' + (String.isNotBlank(language) ? language : 'en_US') + '", \n';
            prompt += '     "items": [ \n';
            prompt += '        { "sku": "FOUND_SKU", "quantity": NUMBER, "action": "add" OR "remove" OR "set" OR "search" OR "show_details" } \n';
            prompt += '     ] \n';
            prompt += '   }\n\n';
            
            prompt += '### USER SAYS:\n' + userMessage;
            
            generationsInput.promptTextorId = prompt;
            generationsInput.additionalConfig = new ConnectApi.EinsteinLlmAdditionalConfigInput();
            generationsInput.additionalConfig.maxTokens = 4000;
            generationsInput.additionalConfig.temperature = 0.5; 
            generationsInput.additionalConfig.applicationName = 'PromptBuilderPreview';
            
            ConnectApi.EinsteinLLMGenerationsOutput generationsOutput = ConnectApi.EinsteinLLM.generateMessages(generationsInput);
            String aiResponseText = generationsOutput.generations[0].text;
            
            aiResponseText = aiResponseText.replace('```json', '').replace('```', '').trim();
            
            result.put('success', true);
            result.put('response', aiResponseText);

        } catch (Exception e) {
            System.debug('Einstein Error: ' + e.getMessage());
            result.put('success', false);
            result.put('message', 'Error: ' + e.getMessage());
        }
        
        return result;
    }

    // --- 10. EINSTEIN FILE ANALYSIS (NOUVEAU) ---

    /**
     * @description Méthode dédiée pour l'analyse de fichiers (CSV/Texte).
     * @param fileContent Le contenu brut du fichier.
     * @param productContextString Le catalogue JSON pour la correspondance.
     * @param userContext Contexte utilisateur.
     */
    @AuraEnabled
    public static Map<String, Object> analyzeFileWithEinstein(
        String fileContent, 
        String productContextString,
        Map<String, Object> userContext
    ) {
        Map<String, Object> result = new Map<String, Object>();
        System.debug('--- 📂 FILE ANALYSIS START ---');

        try {
            String userName = 'User';
            String language = null;
            if (userContext != null) {
                if (userContext.containsKey('userName')) userName = (String)userContext.get('userName');
                if (userContext.containsKey('language')) language = (String)userContext.get('language');
            }

            ConnectApi.EinsteinLlmGenerationsInput generationsInput = new ConnectApi.EinsteinLlmGenerationsInput();
            
            String prompt = 'You are a B2B Data Extraction Assistant processing a file upload from user: ' + userName + '.\n';
            if (String.isNotBlank(language)) {
                prompt += 'Respond in ' + language + '.\n';
            }
            prompt += 'Your goal is to extract PRODUCT REFERENCES and QUANTITIES from the FILE CONTENT below and match them against the CATALOG DATA.\n\n';
            
            prompt += '### CATALOG DATA (JSON):\n' + productContextString + '\n\n';
            
            prompt += '### FILE CONTENT:\n' + fileContent + '\n\n';
            
            prompt += '### INSTRUCTIONS:\n';
            prompt += '1. Parse the file content to find product names, descriptions, or SKUs.\n';
            prompt += '2. Find the matching SKU in the CATALOG DATA.\n';
            prompt += '3. Extract the requested quantity from the file. If no quantity is specified, default to 1.\n';
            prompt += '4. Ignore items that do not match the catalog.\n';
            prompt += '5. Return a JSON Summary.\n';

            prompt += '### OUTPUT FORMAT (JSON ONLY):\n';
            prompt += '   { \n';
            prompt += '     "message": "Summary of what was found (e.g., I found 3 items matching our catalog) in the target language.", \n';
            prompt += '     "detectedLanguage": "' + (String.isNotBlank(language) ? language : 'en_US') + '", \n';
            prompt += '     "items": [ \n';
            prompt += '        { "sku": "MATCHED_SKU", "quantity": NUMBER_FROM_FILE } \n';
            prompt += '     ] \n';
            prompt += '   }\n';

            generationsInput.promptTextorId = prompt;
            generationsInput.additionalConfig = new ConnectApi.EinsteinLlmAdditionalConfigInput();
            generationsInput.additionalConfig.maxTokens = 1000;
            generationsInput.additionalConfig.temperature = 0.2; 
            generationsInput.additionalConfig.applicationName = 'PromptBuilderPreview';
            
            ConnectApi.EinsteinLLMGenerationsOutput generationsOutput = ConnectApi.EinsteinLLM.generateMessages(generationsInput);
            String aiResponseText = generationsOutput.generations[0].text;
            
            aiResponseText = aiResponseText.replace('```json', '').replace('```', '').trim();
            
            result.put('success', true);
            result.put('response', aiResponseText);

        } catch (Exception e) {
            System.debug('File Analysis Error: ' + e.getMessage());
            result.put('success', false);
            result.put('message', 'Error: ' + e.getMessage());
        }
        
        return result;
    }

    // --- 11. GENERATION D'EXPLICATION DES AJUSTEMENTS (MISE A JOUR POUR LISTING EXHAUSTIF) ---

    /**
     * @description Génère une explication conviviale (via IA) pour une liste d'ajustements techniques.
     * @param adjustments Liste de chaînes décrivant les changements.
     * @param userContext Contexte utilisateur.
     * @return Map<String, Object> Contenant la réponse texte de l'IA.
     */
    @AuraEnabled
    public static Map<String, Object> explainAdjustmentsWithEinstein(
        List<String> adjustments,
        Map<String, Object> userContext
    ) {
        Map<String, Object> result = new Map<String, Object>();
        if (adjustments == null || adjustments.isEmpty()) {
            result.put('success', false);
            return result;
        }

        try {
            String userName = 'User';
            String language = null;
            if (userContext != null) {
                if (userContext.containsKey('userName')) userName = (String)userContext.get('userName');
                if (userContext.containsKey('language')) language = (String)userContext.get('language');
            }

            ConnectApi.EinsteinLlmGenerationsInput generationsInput = new ConnectApi.EinsteinLlmGenerationsInput();
            
            String prompt = 'You are a direct B2B Chat Assistant. Do not use email formatting. Do NOT start with a greeting (Hello, Hi). Just explain the changes directly. Keep it very short.\n';
            prompt += 'The user tried to add items to their cart, but some quantities were adjusted due to inventory or business rules (Min/Max/Increment).\n';
            prompt += 'Here is the technical summary of adjustments:\n';
            for(String adj : adjustments) {
                prompt += '- ' + adj + '\n';
            }
            prompt += '\n### INSTRUCTIONS:\n';
            prompt += 'Write a message explaining these changes to ' + userName;
            if (String.isNotBlank(language)) {
                prompt += ' in ' + language;
                prompt += '. IMPORTANT: The response MUST be in ' + language + '. Do not output English unless requested.\n';
            } else {
                prompt += '.\n';
            }
            
            prompt += '1. Highlight the Product Name using HTML bold tags: <b>Product Name</b>.\n';
            prompt += '2. Highlight the Adjusted Quantity or Reason using HTML bold red tags: <b style="color:red">Reason/Qty</b>.\n';
            prompt += '3. Example format (translate to target language): "I updated <b>Air Jordan</b> to <b style="color:red">10 units</b> because of stock limits."\n';
            prompt += '4. You MUST mention EACH item from the list above. Do not summarize (e.g. do NOT say "various items were adjusted").\n';
            
            generationsInput.promptTextorId = prompt;
            generationsInput.additionalConfig = new ConnectApi.EinsteinLlmAdditionalConfigInput();
            generationsInput.additionalConfig.maxTokens = 800; 
            generationsInput.additionalConfig.temperature = 0.5;
            generationsInput.additionalConfig.applicationName = 'PromptBuilderPreview';
            
            ConnectApi.EinsteinLLMGenerationsOutput generationsOutput = ConnectApi.EinsteinLLM.generateMessages(generationsInput);
            String aiResponseText = generationsOutput.generations[0].text;
            
            result.put('success', true);
            result.put('response', aiResponseText);

        } catch (Exception e) {
            System.debug('Adjustment Explanation Error: ' + e.getMessage());
            result.put('success', false);
            result.put('message', e.getMessage());
        }
        return result;
    }

    // --- 12. HELPER DETECTION LANGUE (PUBLIC POUR APPEL LWC DIRECT) ---

    /**
     * @description Méthode publique pour détecter la langue d'un texte via LLM. 
     * Appelée directement par le LWC avant les grosses requêtes.
     * @param text Le texte à analyser.
     * @return Code ISO de la langue (ex: fr, en_US) ou 'Unknown'.
     */
    @AuraEnabled
    public static String detectLanguage(String text) {
        if (String.isBlank(text)) return 'Unknown';
        try {
            ConnectApi.EinsteinLlmGenerationsInput input = new ConnectApi.EinsteinLlmGenerationsInput();
            input.promptTextorId = 'Identify the language of the following text. Return ONLY the ISO code (e.g. en_US, fr, de, es, hi). Do not add any punctuation. Text: ' + text;
            
            input.additionalConfig = new ConnectApi.EinsteinLlmAdditionalConfigInput();
            input.additionalConfig.maxTokens = 10;
            input.additionalConfig.temperature = 0.1; 
            input.additionalConfig.applicationName = 'PromptBuilderPreview';

            ConnectApi.EinsteinLLMGenerationsOutput output = ConnectApi.EinsteinLLM.generateMessages(input);
            String lang = output.generations[0].text.trim();
            if (lang.length() > 5 && lang.contains(' ')) {
                lang = lang.split(' ')[0]; 
            }
            return lang;
        } catch (Exception e) {
            System.debug('Language Detection Failed: ' + e.getMessage());
            return 'Unknown';
        }
    }
}