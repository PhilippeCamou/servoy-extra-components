angular.module('servoyextraTable', ['servoy']).directive('servoyextraTable', ["$log", "$timeout", "$sabloConstants", "$foundsetTypeConstants", "$filter", function($log, $timeout, $sabloConstants, $foundsetTypeConstants, $filter) {
		return {
			restrict: 'E',
			scope: {
				model: "=svyModel",
				svyServoyapi: "=",
				api: "=svyApi",
				handlers: "=svyHandlers"
			},
			link: function($scope, $element, $attrs) {
				var wrapper = $element.find(".tablewrapper")[0];
				var tbody = $element.find("tbody");
				var topSpaceDiv, bottomSpaceDiv;

				var performanceSettings = $scope.model.performanceSettings ? $scope.model.performanceSettings : { minBatchSizeForRenderingMoreRows: 10, minBatchSizeForLoadingMoreRows: 20 }; // by default don't allow too small caches even if the height of the table is very small

				// the number of rows to render in a batch (it renders one batch then when needed renders one more batch on top or bottom and so on)
				// this should be set to at least the UI viewPort when we start calculating that
				var batchSizeForRenderingMoreRows = Math.max(26, performanceSettings.minBatchSizeForRenderingMoreRows); // this should be calculated for now this value is nicer for bigger list (that show already 20+ rows by default)
				// the number of extra rows to be loaded (before/after) if the rendered rows get too close to the loaded rows bounds when scrolling
				// when you change this initial value please update the .spec as well - config option "initialPreferredViewPortSize" on the foundset property should match getPreferredInitialViewportSize
				var batchSizeForLoadingMoreRows = Math.max(52, performanceSettings.minBatchSizeForLoadingMoreRows) // this should be higher then batchSizeForRenderingMoreRows because when we load more rows we should load enough to at least be able to render one more batch of rendered rows; so when that one (batchSizeForRenderingMoreRows) is calculated adjust this one as well
				// just for logging purposes
				var oldAverageRowHeight = 25;

				// RENDERED bounds: the rendered rows are actually present in DOM with all data in them; rendered rows can be only a part of the LOADED viewport (so what model.foundset.viewport has)
				// the start row index of the first rendered row - relative to start of foundset (so not to any viewport)
				var renderedStartIndex = 0;
				// the number rendered rows
				var renderedSize = -1;

				// used to avoid a situation where extra or less records are requested multiple times because previous load data requests have not yet arrived back from server to adjust viewport;
				// for example if we calculate that we need 3 less records we send loadLess..(3) but if meanwhile an event happens on client that makes us check that again before we get the new
				// viewport from server we don't want to end up requesting 3 less again (cause in the end our viewport will be 3 records shorter then we want it then)
				var loadingRecordsPromise;

				// this is true when next render of table contents / next scroll selection into view should scroll to selection;
				// false if it shouldn't change page/load records around selection, for example if the user has just changed to another page manually and table got re-rendered, or browser page refresh
				var scrollToSelectionNeeded = ($scope.model.lastSelectionFirstElement == -1); // when this is called due to a browser refresh don't necessarily go to selection; only force the scroll on initial show or if the selection changed (see selected indexes watch)

				// some coefficients that decide the batch sizes for rendering and loading based on visible area row count; we can play with these to see if we can have a smoother scroll feeling
				var magicRenderBatchQ = 1.5;
				var magicLoadBatchQ = 3;

				if ($log.debugEnabled && $log.debugLevel === $log.SPAM)
					$log.debug("svy extra table * initially scrollToSelectionNeeded = " + scrollToSelectionNeeded);

				function getInitialRenderSize() {
					var potentialInitialRenderSize = Math.floor(batchSizeForRenderingMoreRows * 3);
					return $scope.model.pageSize > 0 ? Math.min(potentialInitialRenderSize, $scope.model.pageSize) : potentialInitialRenderSize;
				}

				// this is actually the preferred viewport size that the server will send automatically when foundset data completely changes
				// it should be maximum pageSize if that is > 0 or (when we implement it) -1 (so auto paging)
				function getPreferredInitialViewportSize() {
					var potentialInitialViewportSize = Math.floor(batchSizeForLoadingMoreRows * 2.5);
					return ($scope.model.pageSize > 0 && $scope.model.pageSize < potentialInitialViewportSize) ? $scope.model.pageSize : potentialInitialViewportSize;
				}

				// func gets called if there is no pending load in progress, otherwise delayedFunc will get called after load-in-progress is done;
				// delayedFunc is optional; if not specified, func will be used even if it has to wait for a pending promise to complete;
				// func/delayedFunc can return another new pending load promise, if it requested another load while executing; this load will delay further any other pending executions
				function runWhenThereIsNoPendingLoadRequest(func, delayedFunc) {
					// if we are already in the process of loading records from server, wait for it to be done/resolved
					// before making more load requests; see comment on loadingRecordsPromise declaration
					var fToExec = func;

					function checkLoadingAndRun() {
						//if ($log.debugEnabled && $log.debugLevel === $log.SPAM) $log.debug("svy extra table * runWhenThereIsNoPendingLoadRequest checkLoadingAndRun()");
						if (!loadingRecordsPromise) {
							var newLoadingRecordsPromise = fToExec(); // the function can return another promise if it did a new loadXYZ request on foundset property
							if (!loadingRecordsPromise) loadingRecordsPromise = newLoadingRecordsPromise; // but fToExec might also call inside it another runWhenThereIsNoPendingLoadRequest that will execute right away and might have set the loadingRecordsPromise already; we don't want that one to get lost
							else if (loadingRecordsPromise !== newLoadingRecordsPromise) $log.warn("svy extra table * runWhenThereIsNoPendingLoadRequest - it seems that one of the functions that executed both calls runWhenThereIsNoPendingLoadRequest that gives a promise as well as returns a different promise - the returned promise will be ignored..."); // this else should never happen in how it is used here in table.js
							
							//if ($log.debugEnabled && $log.debugLevel === $log.SPAM) $log.debug("svy extra table * runWhenThereIsNoPendingLoadRequest pending exec executed; new loadingPromise is " + (loadingRecordsPromise ? "SET" : "still NOT SET"));

							if (loadingRecordsPromise) loadingRecordsPromise.finally(function() {
									// when we are done loading stuff, clear the promise so we know we aren't waiting for a load;
									// (hmm here we rely on finally blocks that are registered on the same promise being called in the order they in which they were registered (so undefined is set before any new fToExec that was waiting can set it to the new value))
									loadingRecordsPromise = undefined;
									//if ($log.debugEnabled && $log.debugLevel === $log.SPAM) $log.debug("svy extra table * runWhenThereIsNoPendingLoadRequest - loadingPromise is now resolved, so NOT SET...");
								});
						} else {
							// probably more functions were waiting to exec after previous load and one of the others already executed and requested another load... so wait for the new load
							loadingRecordsPromise.finally(checkLoadingAndRun);
						}
					}

					if (loadingRecordsPromise && delayedFunc) fToExec = delayedFunc;
					checkLoadingAndRun();
				}

				function getNumberFromPxString(s) {
					var numberFromPxString = -1;
					if (s) {
						s = s.trim().toLowerCase();
						if (s.indexOf("px") == s.length - 2) {
							s = s.substring(0, s.length - 2);
						}
						if ($.isNumeric(s)) {
							numberFromPxString = parseInt(s);

						}
					}
					return numberFromPxString;
				}

				function calculateTableWidth() {
					var tableWidth = 0;
					if ($scope.model.columns) {
						for (var i = 0; i < $scope.model.columns.length; i++) {
							if (!$scope.model.columns[i].autoResize && getNumberFromPxString($scope.model.columns[i].initialWidth) > 0) {
								var w = getNumberFromPxString($scope.model.columns[i].width);
								if (w > -1) {
									tableWidth += w;
								}
							}
						}
					}
					return tableWidth;
				}

				function getAutoColumns() {
					var autoColumns = { columns: { }, minWidth: { }, count: 0 };
					if ($scope.model.columns) {
						for (var i = 0; i < $scope.model.columns.length; i++) {
							if ($scope.model.columns[i].initialWidth == undefined) {
								$scope.model.columns[i].initialWidth = $scope.model.columns[i].width == undefined ? "" : $scope.model.columns[i].width;
							} else {
								$scope.model.columns[i].width = $scope.model.columns[i].initialWidth;
							}
							var minWidth = getNumberFromPxString($scope.model.columns[i].width);
							if ($scope.model.columns[i].autoResize || minWidth < 0) {
								autoColumns.columns[i] = true;
								autoColumns.minWidth[i] = minWidth;
								autoColumns.count += 1;
							}
						}
					}

					return autoColumns;
				}

				function updateAutoColumnsWidth(delta) {
					columnStyleCache = [];
					var componentWidth = getComponentWidth();
					var oldWidth = componentWidth - delta;
					for (var i = 0; i < $scope.model.columns.length; i++) {
						if (autoColumns.columns[i]) {
							if (autoColumns.minWidth[i] > 0) {
								var w = Math.floor(getNumberFromPxString($scope.model.columns[i].width) * componentWidth / oldWidth);
								if (w < autoColumns.minWidth[i]) {
									w = autoColumns.minWidth[i];
								}
								$scope.model.columns[i].width = w + "px";
							} else {
								$scope.model.columns[i].width = $scope.model.columns[i].initialWidth;
							}
						}
					}
				}

				$scope.componentWidth = 0;
				function getComponentWidth() {
					if (!$scope.componentWidth) {
						$scope.componentWidth = $element.parent().width();
					}
					return $scope.componentWidth;
				}

				var autoColumns = getAutoColumns();
				var tableWidth = calculateTableWidth();

				var tableLeftOffset = 0;
				var onTBodyScrollListener = null;
				var resizeTimeout = null;

				function onColumnResize(event) {
					var table = $element.find("table:first");
					var headers = table.find("th");

					for (var i = 0; i < headers.length; i++) {
						var header = $(headers.get(i));
						if ( (autoColumns.minWidth[i] > 0) && (getNumberFromPxString(header[0].style.width) < autoColumns.minWidth[i])) {
							$scope.model.columns[i].width = autoColumns.minWidth[i] + "px";
							updateAutoColumnsWidth(0);
							$timeout(function() {
									addColResizable(true);
								}, 0);
							return;
						}
						$scope.model.columns[i].width = header[0].style.maxWidth = header[0].style.minWidth = header[0].style.width;
						updateTableColumnStyleClass(i, { width: $scope.model.columns[i].width, minWidth: $scope.model.columns[i].width, maxWidth: $scope.model.columns[i].width });
					}
					var resizer = $element.find(".JCLRgrips");
					var resizerLeft = getNumberFromPxString($(resizer).css("left"));

					var colGrips = $element.find(".JCLRgrip");
					var leftOffset = 1;
					for (var i = 0; i < colGrips.length; i++) {
						leftOffset += getNumberFromPxString($scope.model.columns[i].width);
						$(colGrips.get(i)).css("left", leftOffset - resizerLeft + "px");
					}
					updateTBodyStyle($element.find('tbody')[0]);

					if($scope.handlers.onColumnResize) {
						$scope.handlers.onColumnResize(event);
					}
				}

				var windowResizeHandler = function() {
					if (resizeTimeout) $timeout.cancel(resizeTimeout);
					resizeTimeout = $timeout(function() {
							$scope.$apply(function() {
								if ($scope.model.columns) {
									var newComponentWidth = $element.parent().width();
									var deltaWidth = newComponentWidth - getComponentWidth();
									if (deltaWidth != 0) {
										$scope.componentWidth = newComponentWidth;
										updateTBodyStyle(tbody[0]);
										if ($scope.model.columns && $scope.model.columns.length > 0) {
											updateAutoColumnsWidth(deltaWidth);
											$timeout(function() {
													if ($scope.model.enableColumnResize) {
														addColResizable(true);
													} else {
														for (var i = 0; i < $scope.model.columns.length; i++) {
															updateTableColumnStyleClass(i, getCellStyle(i));
														}
													}
												}, 0);
										}
									}
								}

								// see if more rows need to be rendered due to resize
								if (updateBatchSizesIfNeeded(getAverageRowHeight())) {
									adjustLoadedRowsIfNeeded();
									updateRenderedRows(null);
								}
							})
						}, 50);
				}
				$(window).on('resize', windowResizeHandler);

				function addColResizable(cleanPrevious) {
					var tbl = $element.find("table:first");
					if (cleanPrevious) {
						tbl.colResizable({
							disable: true,
							removePadding: false
						});
					}
					tbl.colResizable({
						liveDrag: false,
						resizeMode: "fit",
						onResize: function(e) {
							$scope.$apply(function() {
								onColumnResize(e);
							})
						},
						removePadding: false
					});
					// don't want JColResize to change the column width on window resize
					$(window).unbind('resize.JColResizer');
					// update the model with the right px values
					var headers = tbl.find("th");
					if ($(headers).is(":visible")) {
						for (var i = 0; i < $scope.model.columns.length; i++) {
							if (autoColumns.columns[i] && autoColumns.minWidth[i] < 0) {
								$scope.model.columns[i].width = $(headers.get(i)).outerWidth(false) + "px";
								updateTableColumnStyleClass(i, { width: $scope.model.columns[i].width, minWidth: $scope.model.columns[i].width, maxWidth: $scope.model.columns[i].width });
							}
						}
						updateTBodyStyle(tbl.find("tbody")[0]);
					}
				}

				function scrollToRenderedIfNeeded() {
					// this should NOT be called when waiting for more rows to render/load due to a scroll up/scroll down!

					// if rendered rows are not visible due to scroll, do scroll to the rendered rows to not show blank content;
					// this can happen for example if you show a table in a tab-panel, scroll down, switch to another tab and then back
					// in which case table renders, but loaded and rendered will be somewhere to the bottom while scrollbar for the table
					// (which has just been re-created as a DOM element) is at top showing the empty space dir - so blank

					// when this method is called tbody should always be scrolled to top (as this method should be called after a refresh or show/hide only)
					if (tbody && tbody.scrollTop() == 0 && tbody.children().length - (topSpaceDiv ? 1 : 0) - (bottomSpaceDiv ? 1 : 0) > 0) {
						// center visible area on rendered if possible; if selection is part of rendered center on selection
						// TODO should we try to keep scroll exactly where it was before instead of centering on the rendered rows? so somehow store last scrollTop in the component's model (server side)
						var targetIntervalPosition = renderedStartIndex;
						var targetIntervalSize = renderedSize;
						var firstSelected = $scope.model.foundset.selectedRowIndexes.length == 1 ? $scope.model.foundset.selectedRowIndexes[0] : -1; // we do not scroll to selection if there is no selected record (serverSize is probably 0) or we have multi-select with more then one or 0 selected records

						var shouldScroll = false;
						if (firstSelected >= renderedStartIndex && firstSelected < renderedStartIndex + renderedSize) {
							targetIntervalPosition = firstSelected;
							targetIntervalSize = 1;
							shouldScroll = true; // scroll to selection (which is in rendered rows) as this was most likely what user was looking at before
						}

						if (tbody.children()[topSpaceDiv ? 1 : 0].offsetTop > 0) {
							shouldScroll = true; // scroll to some rendered row, be it selection above or not; because we are currently showing white space
						}

						if (shouldScroll) {
							var computedInterval = centerIntervalAroundOldIntervalIfPossible(targetIntervalPosition, targetIntervalSize, renderedStartIndex, renderedSize, Math.floor(tbody.height() / getAverageRowHeight()));
							tbody.scrollTop(tbody.children()[computedInterval[0] - renderedStartIndex + (topSpaceDiv ? 1 : 0)].offsetTop);

							if ($log.debugEnabled && $log.debugLevel === $log.SPAM) $log.debug("svy extra table * scrollToRenderedIfNeeded did scroll to rendered viewport on initial load/refresh");
						}
					}
				}

				function onTableRendered() {
					updateSelection($scope.model.foundset.selectedRowIndexes, null);
					scrollToSelectionIfNeeded();
					adjustLoadedRowsIfNeeded();

					if (!onTBodyScrollListener) {
						onTBodyScrollListener = function() {
							$timeout(function() {
								tableLeftOffset = -tbody.scrollLeft();
								var resizer = $element.find(".JCLRgrips");
								if (resizer.get().length > 0) {
									$(resizer).css("left", tableLeftOffset + "px");
								}
							});
						}
						tbody.bind("scroll", onTBodyScrollListener);
					}
					if ($scope.model.enableColumnResize) {
						autoColumns = getAutoColumns();
						tableWidth = calculateTableWidth();
						updateAutoColumnsWidth(0);
						addColResizable(true);
					}
				}

				function getPageForIndex(idx) {
					return Math.floor(Math.max(idx, 0) / $scope.model.pageSize) + 1;
				}

				function setCurrentPage(newCurrentPage) {
					if ($scope.model.currentPage != newCurrentPage) {
						$scope.model.currentPage = newCurrentPage;
						renderedStartIndex = 0;
						renderedSize = -1; // when we change page make sure rendered rows will be as many as needed again (just in case for example previously rendered rows were just a few of last page)
					}
				}

				// this function also adjusts current page if needed (if it's after the foundset size for example)
				function calculateAllowedLoadedDataBounds() {
					var allowedStart;
					var allowedSize;

					var fs = $scope.model.foundset;
					var serverSize = fs.serverSize;
					if ($scope.showPagination()) {
						// paging mode only keeps data for the showing page - at maximum
						allowedStart = $scope.model.pageSize * ($scope.model.currentPage - 1);
						if (allowedStart >= serverSize) {
							// this page no longer exists; it is after serverSize; adjust current page and that watch on that will request the correct viewport
							setCurrentPage(getPageForIndex(serverSize - 1));
							allowedStart = $scope.model.pageSize * ($scope.model.currentPage - 1);
						}

						allowedSize = Math.min($scope.model.pageSize, serverSize - allowedStart);
					} else {
						// table is not going to show/use pages; so we can think of it as one big page
						setCurrentPage(1); // just to be sure - we are not paging so we are on first "page"

						allowedStart = 0;
						allowedSize = serverSize;
					}
					return { startIdx: allowedStart, size: allowedSize };
				}

				// tries to center new interval of desired size around old interval without going past allowed bounds
				function centerIntervalAroundOldIntervalIfPossible(oldStartIdx, oldSize, allowedStartIdx, allowedSize, newDesiredSize) {
					// try to compute center start index and compute size (if it doesn't fit in the beginning slide towards end of allowed as much as possible)
					var computedStart = Math.max(oldStartIdx - Math.floor( (newDesiredSize - oldSize) / 2), allowedStartIdx);
					var computedSize = Math.min(newDesiredSize, allowedStartIdx + allowedSize - computedStart);

					// if newDesiredSize is still not reached, see if we can slide the interval towards the beginning of allowed
					if (computedSize < newDesiredSize && computedStart > allowedStartIdx) {
						computedStart = Math.max(allowedStartIdx + allowedSize - newDesiredSize, allowedStartIdx);
						computedSize = Math.min(newDesiredSize, allowedStartIdx + allowedSize - computedStart);
					}

					return [computedStart, computedSize];
				}

				function adjustLoadedRowsIfNeeded() {
					runWhenThereIsNoPendingLoadRequest(function() {
						var newLoadingPromise; // return value if this function calls any loadXYZ methods on the foundset property
						var serverSize = $scope.model.foundset.serverSize;

						var neededVpStart;
						var neededVpSize;

						var fs = $scope.model.foundset;
						var vpStart = fs.viewPort.startIndex;
						var vpSize = fs.viewPort.size;

						// the purpose of this method is to request more rows from the server if needed;
						// the idea is to only load extra or less records instead of fully loading a new viewport - if possible

						// first calculate the maximum bounds in which we can load records (depending on whether it is paging or not)
						var allowedBounds = calculateAllowedLoadedDataBounds(); // { startIdx, size }
						var allowedStart = allowedBounds.startIdx;
						var allowedSize = allowedBounds.size;

						if ($scope.showPagination() && ( (vpStart < allowedStart && vpStart + vpSize <= allowedStart) || (vpStart >= allowedStart + allowedSize && vpStart + vpSize > allowedStart + allowedSize))) {
							// if the viewport is completely outside of the current page - load first batch of the page, don't try to make best quest closest to current viewport
							neededVpStart = allowedStart;
							neededVpSize = Math.min(getPreferredInitialViewportSize(), allowedSize); // initial load loads more then scroll load batch size
						} else {
							// if loaded viewport bounds are not inside allowed bounds, or if too few rows are loaded, calculate the correct neededVpStart and neededVpSize
							// first shrink loaded to allowed bounds if needed
							neededVpStart = Math.min(allowedStart + allowedSize - 1, Math.max(vpStart, allowedStart));
							neededVpSize = Math.max(0, Math.min(allowedSize - (neededVpStart - allowedStart), vpSize - (neededVpStart - vpStart)));

							// now the 'shrinked to allowed bounds' loaded rows could be 0 in which case we need to load first rows of the allowed interval
							// or they could be only a few in which case we just need to check if it's enough of them or not (compared to batchSizeForLoadingMoreRows)
							if (neededVpSize > 0) {
								// all is ok, just make sure that minimum getPreferredInitialViewportSize() are already loaded; if not, then load some more
								if (neededVpSize < getPreferredInitialViewportSize()) {
									// center on currently loaded viewport and load more rows so that getPreferredInitialViewportSize() is reached

									var computedInterval = centerIntervalAroundOldIntervalIfPossible(vpStart, vpSize, allowedStart, allowedSize, getPreferredInitialViewportSize());
									neededVpStart = computedInterval[0];
									neededVpSize = computedInterval[1];
								} // else needed bounds are already ok, we have at least the loaded batch size records already loaded
							} else {
								// loaded bounds are completely outside of current allowed interval (page in this case); request default new one at start of page
								neededVpStart = allowedStart;
								neededVpSize = Math.min(getPreferredInitialViewportSize(), allowedSize); // initial load loads more then scroll load batch size
							}
						}

						if (vpStart != neededVpStart || vpSize != neededVpSize) {
							if ($log.debugEnabled && $log.debugLevel === $log.SPAM) $log.debug("svy extra table * adjustLoadedRowsIfNeeded will do what is needed to have new loaded viewport of (" + neededVpStart + ", " + neededVpSize + ")");
							newLoadingPromise = smartLoadNeededViewport(neededVpStart, neededVpSize);
						}

						return newLoadingPromise;
					});
				}

				function smartLoadNeededViewport(neededVpStart, neededVpSize) {
					var newLoadingPromise;

					var fs = $scope.model.foundset;
					var vpStart = fs.viewPort.startIndex;
					var vpSize = fs.viewPort.size;

					var neededVpEnd = neededVpStart + neededVpSize - 1;
					var vpEnd = vpStart + vpSize - 1;

					var intersectionStart = Math.max(neededVpStart, vpStart);
					var intersectionEnd = Math.min(neededVpEnd, vpEnd);

					if (intersectionStart <= intersectionEnd) {
						// we already have some or all records that we need; request or trim only the needed rows
						if (neededVpStart < vpStart) newLoadingPromise = fs.loadExtraRecordsAsync(neededVpStart - vpStart, true);
						else if (neededVpStart > vpStart) newLoadingPromise = fs.loadLessRecordsAsync(neededVpStart - vpStart, true);

						if (neededVpEnd < vpEnd) newLoadingPromise = fs.loadLessRecordsAsync(neededVpEnd - vpEnd, true);
						else if (neededVpEnd > vpEnd) newLoadingPromise = fs.loadExtraRecordsAsync(neededVpEnd - vpEnd, true);

						fs.notifyChanged();
					} else {
						// we have none of the needed records - just request the whole wanted viewport
						newLoadingPromise = fs.loadRecordsAsync(neededVpStart, neededVpSize);
					}

					return newLoadingPromise;
				}

				// this watch is registered before others that call adjustLoadedRowsIfNeeded (like the watch on 'model.foundset.serverSize' for example)
				// because it needs to adjust current page first in order to avoid adjustLoadedRowsIfNeeded loading rows for an outdated page
				$scope.$watch('model.foundset.selectedRowIndexes', function(newValue, oldValue) {
						// ignore value change triggered by the watch initially with the same value except for when it was a form re-show and the selected index changed meanwhile
						if (newValue.length > 0) {
							if ( (newValue != oldValue || $scope.model.lastSelectionFirstElement != newValue[0]) && $scope.model.foundset) {
								updateSelection(newValue, oldValue);
								if ($scope.model.lastSelectionFirstElement != newValue[0]) {
									scrollToSelectionNeeded = true;
									if ($log.debugEnabled && $log.debugLevel === $log.SPAM)
										$log.debug("svy extra table * selectedRowIndexes watch; scrollToSelectionNeeded = true");
									scrollToSelectionIfNeeded();
								}
							}
							$scope.model.lastSelectionFirstElement = newValue[0];
						} else $scope.model.lastSelectionFirstElement = -1;
					}, true);

				$scope.$watch('model.foundset.serverSize', function(newValue, oldValue) {
						if (newValue && newValue != oldValue) {
							adjustLoadedRowsIfNeeded(); // load more if available and needed, or decrease page in case current page no longer exists
							updateTopAndBottomEmptySpace();
						}
					});

				$scope.$watch('model.foundset.viewPort.startIndex', function(newValue, oldValue) {
						if (newValue && newValue != oldValue) {
							// handle a situation where only startIndex and server size got updated due to a delete of rows before the currently loaded viewport,
							// when the viewport is at the end of the foundset; we check if the foundset index stored in rows matches the new indexes
							// to avoid calling update if it was only a normal viewport change

							// I am using evalAsync here so that this executes hopefully after the evalAsync from foundsetListener
							// TODO as this is a very specific scenario and not nice impl., please remove this watch and evalAsync as part of SVY-10706 (do it through the listener instead)
							$scope.$evalAsync(function() {
								var vp = $scope.model.foundset.viewPort;
								if (renderedStartIndex < vp.startIndex || renderedStartIndex + renderedSize > vp.startIndex + vp.size) {
									updateRenderedRows(null);
								}
							});
						}
					});

				// watch the columns so that we can relay out the columns when width or size stuff are changed.
				var currentColumnLength = $scope.model.columns ? $scope.model.columns.length : 0;
				Object.defineProperty($scope.model, $sabloConstants.modelChangeNotifier, {
						configurable: true,
						value: function(property, value) {
							switch (property) {
							case "columns":
								var differentColumns = currentColumnLength != $scope.model.columns.length;
								var valueChanged = differentColumns;
								currentColumnLength = $scope.model.columns.length
								if (!valueChanged) {
									for (var i = 0; i < $scope.model.columns.length; i++) {
										var iw = getNumberFromPxString($scope.model.columns[i].initialWidth);
										if (iw > -1 && ($scope.model.columns[i].width != $scope.model.columns[i].initialWidth)) {
											$scope.model.columns[i].initialWidth = $scope.model.columns[i].width;
											if (!valueChanged) valueChanged = true;
										}
									}
								}

								if (valueChanged) {
									autoColumns = getAutoColumns();
									tableWidth = calculateTableWidth();
									if ($scope.model.columns && $scope.model.columns.length > 0) {
										updateAutoColumnsWidth(0);
										$timeout(function() {
												if ($scope.model.enableColumnResize) {
													addColResizable(true);
												} else {
													for (var i = 0; i < $scope.model.columns.length; i++) {
														updateTableColumnStyleClass(i, getCellStyle(i));
													}
												}
												if (differentColumns) generateTemplate(true);
											}, 0);
									}
								}
								// if the columns didn't change completely then test for the style class
								if (!differentColumns) updateColumnStyleClass();
								break;
							}
						}
					});

				$scope.$watch('model.foundset.viewPort.rows', function(newValue, oldValue) {
						// full viewport update (it changed by reference); start over with renderedSize
						generateTemplate();
					})

				$scope.$watch('model.currentPage', function(newValue, oldValue) {
						if (newValue && newValue != oldValue) {
							adjustLoadedRowsIfNeeded(); // load needed records from new page if needed
						}
					});

				$scope.$watch('model.pageSize', function(newValue, oldValue) {
						if (oldValue != newValue) {
							// start over with renderedSize
							renderedSize = -1;

							if (oldValue && newValue && $scope.showPagination()) {
								// page size has changed; try to show the page for which we have loaded records
								setCurrentPage(getPageForIndex($scope.model.foundset.viewPort.startIndex));
								adjustLoadedRowsIfNeeded(); // load more rows if needed according to new page bounds
							}
						}
						$scope.model.foundset.setPreferredViewportSize(getPreferredInitialViewportSize());
					});

				$scope.$watch('model.foundset.viewPort', function(newValue, oldValue) {
						adjustLoadedRowsIfNeeded();
					});

				$scope.$watch('model.foundset.sortColumns', function(newValue, oldValue) {
						if (newValue) {
							var sortColumnsA = $scope.model.foundset.sortColumns.split(" ");
							if (sortColumnsA.length == 2) {
								for (var i = 0; i < $scope.model.columns.length; i++) {
									if (sortColumnsA[0] == $scope.model.columns[i].dataprovider.idForFoundset) {
										$scope.model.sortColumnIndex = i;
										$scope.model.sortDirection = sortColumnsA[1].toLowerCase() == 'asc' ? 'up' : 'down';
										break;
									}
								}
							}
						}
					});

				var toBottom = false;
				$scope.$watch('model.visible', function(newValue) {
						if (newValue) {
							wrapper = $element.find(".tablewrapper")[0];
							tbody = $element.find("tbody");

							// as model.visible is used in an ng-if around both these elements and that didn't execute yet, give it a chance to do so
							if (! (wrapper && tbody)) $scope.$evalAsync(function() {
									wrapper = $element.find(".tablewrapper")[0];
									tbody = $element.find("tbody");
								});

							// TODO do we need to reinitialize anything else here as the elements were recreated
						} else {
							toBottom = false;
							tbody = null;
							topSpaceDiv = null
							bottomSpaceDiv = null;
							wrapper = null;
						}
					});

				function scrollToSelectionIfNeeded() {
					if (!scrollToSelectionNeeded) return;

					var firstSelected = $scope.model.foundset.selectedRowIndexes.length == 1 ? $scope.model.foundset.selectedRowIndexes[0] : -1; // we do not scroll to selection if there is no selected record (serverSize is probably 0) or we have multi-select with more then one or 0 selected records

					if (firstSelected >= 0) {
						// we must scroll to selection; see if we need to load/render other records in order to do this
						if ($scope.showPagination() && getPageForIndex(firstSelected) != $scope.model.currentPage) {
							// we need to switch page in order to show selected row
							setCurrentPage(getPageForIndex(firstSelected));
						}

						// check if the selected row is in the current ui viewport.
						if (tbody && tbody.children().length - (topSpaceDiv ? 1 : 0) - (bottomSpaceDiv ? 1 : 0) > 0 && (firstSelected < renderedStartIndex || firstSelected >= (renderedStartIndex + renderedSize))) {
							// it's not in the current rendered viewport, check if it is in the current data viewport
							var vp = $scope.model.foundset.viewPort;
							if (firstSelected < vp.startIndex || firstSelected >= (vp.startIndex + vp.size)) {
								runWhenThereIsNoPendingLoadRequest(function() {
										// selection is not inside the viewport, request another viewport around the selection.
										var allowedBounds = calculateAllowedLoadedDataBounds(); // { startIdx, size }
										var allowedStart = allowedBounds.startIdx;
										var allowedSize = allowedBounds.size;

										// center on the selection if possible, if not try to load 'getPreferredInitialViewportSize()' anyway in total
										var computedInterval = centerIntervalAroundOldIntervalIfPossible(firstSelected, 0, allowedStart, allowedSize, getPreferredInitialViewportSize());
										var neededVpStart = computedInterval[0];
										var neededVpSize = computedInterval[1];

										if ($log.debugEnabled && $log.debugLevel === $log.SPAM) $log.debug("svy extra table * scrollToSelectionIfNeeded will do what is needed to have new loaded viewport of (" + neededVpStart + ", " + neededVpSize + ")");
										newLoadPromise = smartLoadNeededViewport(neededVpStart, neededVpSize);
										newLoadPromise.then(function() {
											updateRenderedRows(null);
										});

										return newLoadPromise;
									}, scrollToSelectionIfNeeded);
							} else {
								updateRenderedRows(null); // this will center rendered rows and scroll position change might load more needed records around the already-present selected row
							}
						} else {
							// really scroll to selection; it should be already there
							var firstSelectedRelativeToRendered = firstSelected - renderedStartIndex;

							var child = (firstSelectedRelativeToRendered >= 0 ? tbody.children().eq(firstSelectedRelativeToRendered + (topSpaceDiv ? 1 : 0)) : undefined); // eq negative idx is interpreted as n'th from the end of children list
							if (child && child.length > 0 && child[0]) {
								var wrapperRect = tbody[0].getBoundingClientRect();
								var childRect = child[0].getBoundingClientRect();
								if (Math.floor(childRect.top) < Math.floor(wrapperRect.top) || Math.floor(childRect.bottom) > Math.floor(wrapperRect.bottom)) {
									child[0].scrollIntoView(!toBottom);
								}
								scrollToSelectionNeeded = false; // now reset the flag so that it is only set back to true on purpose
								if ($log.debugEnabled && $log.debugLevel === $log.SPAM)
									$log.debug("svy extra table * scrollToSelectionIfNeeded; scroll done, scrollToSelectionNeeded = false");
							}
						}
					}

				}

				$scope.hasNext = function() {
					return $scope.model.foundset && $scope.model.currentPage < Math.ceil($scope.model.foundset.serverSize / $scope.model.pageSize);
				}

				$scope.showPagination = function() {
					return $scope.model.pageSize && $scope.model.foundset && $scope.model.foundset.serverSize > $scope.model.pageSize;
				}

				var isPaginationVisible = false;
				$scope.isPaginationVisible = function() {
					var isPaginationVisibleNew = $scope.showPagination();
					if (isPaginationVisible != isPaginationVisibleNew) {
						isPaginationVisible = isPaginationVisibleNew;
						$timeout(function() {
								if (tbody[0]) {
									if ($scope.showPagination()) {
										var pagination = $element.find("ul:first");
										if (pagination.get().length > 0) {
											tbody[0].style['marginBottom'] = ($(pagination).height() + 2) + "px";
										}
									} else {
										tbody[0].style['marginBottom'] = "";
									}
								}
							}, 0);
					}
					return isPaginationVisible;
				}

				$scope.modifyPage = function(count) {
					var pages = Math.ceil($scope.model.foundset.serverSize / $scope.model.pageSize)
					var newPage = $scope.model.currentPage + count;
					if (newPage >= 1 && newPage <= pages) {
						setCurrentPage(newPage);
					}
				}

				function getFoundsetIndexFromViewportIndex(idx) {
					return $scope.model.foundset.viewPort.startIndex + idx;
				}

				function getViewportIndexFromFoundsetIndex(idx) {
					return idx - $scope.model.foundset.viewPort.startIndex;
				}

				$scope.tableClicked = function(event, type) {
					var elements = document.querySelectorAll(':hover');
					for (var i = elements.length; --i > 0;) {
						var row_column = $(elements[i]).data("row_column");
						if (row_column) {
							var columnIndex = row_column.column;
							var idxInFs = row_column.idxInFs;
							var idxInViewport = getViewportIndexFromFoundsetIndex(idxInFs);
							var newSelection = [idxInFs];
							//    				 if($scope.model.foundset.multiSelect) {
							if (event.ctrlKey) {
								newSelection = $scope.model.foundset.selectedRowIndexes ? $scope.model.foundset.selectedRowIndexes.slice() : [];
								var idxInSelected = newSelection.indexOf(idxInFs);
								if (idxInSelected == -1) {
									newSelection.push(idxInFs);
								} else if (newSelection.length > 1) {
									newSelection.splice(idxInSelected, 1);
								}
							} else if (event.shiftKey) {
								var start = -1;
								if ($scope.model.foundset.selectedRowIndexes) {
									for (var j = 0; j < $scope.model.foundset.selectedRowIndexes.length; j++) {
										if (start == -1 || start > $scope.model.foundset.selectedRowIndexes[j]) {
											start = $scope.model.foundset.selectedRowIndexes[j];
										}
									}
								}
								var stop = idxInFs;
								if (start > idxInFs) {
									stop = start;
									start = idxInFs;
								}
								newSelection = []
								for (var n = start; n <= stop; n++) {
									newSelection.push(n);
								}
							}
							//    				 }

							$scope.model.foundset.requestSelectionUpdate(newSelection);
							if (type == 1 && $scope.handlers.onCellClick) {
								$scope.handlers.onCellClick(idxInFs + 1, columnIndex, $scope.model.foundset.viewPort.rows[idxInViewport], event);
							}

							if (type == 2 && $scope.handlers.onCellRightClick) {
								$scope.handlers.onCellRightClick(idxInFs + 1, columnIndex, $scope.model.foundset.viewPort.rows[idxInViewport], event);
							}
						}
					}
				}
				if ($scope.handlers.onCellRightClick) {
					$scope.tableRightClick = function(event) {
						$scope.tableClicked(event, 2);
					}
				}

				function doFoundsetSQLSort(column) {
					if ($scope.model.columns[column].dataprovider) {
						var sortCol = $scope.model.columns[column].dataprovider.idForFoundset;
						var sqlSortDirection = "asc";
						if ($scope.model.foundset.sortColumns) {
							var sortColumnsA = $scope.model.foundset.sortColumns.split(" ");
							if (sortCol == sortColumnsA[0]) {
								sqlSortDirection = sortColumnsA[1].toLowerCase() == "asc" ? "desc" : "asc";
							}
						}
						$scope.model.foundset.sortColumns = sortCol + " " + sqlSortDirection;
						$scope.model.foundset.sort([{ name: sortCol, direction: sqlSortDirection }]);
					}
				}

				if ($scope.model.enableSort || $scope.handlers.onHeaderClick) {
					$scope.headerClicked = function(event, column) {
						if ($scope.handlers.onHeaderClick) {
							if ($scope.model.enableSort && ($scope.model.sortColumnIndex != column)) {
								$scope.model.sortDirection = null;
							}
							$scope.handlers.onHeaderClick(column, $scope.model.sortDirection, event).then(function(ret) {
									if ($scope.model.enableSort) {
										$scope.model.sortColumnIndex = column;
										$scope.model.sortDirection = ret;
										if (!$scope.model.sortDirection) {
											doFoundsetSQLSort($scope.model.sortColumnIndex);
										}
									}
								}, function(reason) {
									$log.error(reason);
								});
						} else if ($scope.model.enableSort) {
							$scope.model.sortColumnIndex = column;
							doFoundsetSQLSort($scope.model.sortColumnIndex);
						}

					}
				}

				function getRowIndexInFoundset(rowElement) {
					if (rowElement) {
						// take the index in loaded viewport from dom element (to make sure we really target the same row
						// no matter the values of renderedSize and renderedStartIndex (they might have been altered before for rendering))
						// something else alreaady and then they are out-of-sync with child elements already)
						// so we can't rely on the fact that the Nth DOM child is the Nth relative to renderedStartIndex in some cases
						var row_column = $(rowElement).children().eq(0).data("row_column");
						if (row_column) {
							return row_column.idxInFs;
						}
					}
					return -1;
				}

				function getFirstVisibleChild() {
					if ($log.debugEnabled && $log.debugLevel === $log.SPAM)
						$log.debug("svy extra table * getFirstVisibleChild called");

					var tbodyScrollTop = tbody.scrollTop();
					var children = tbody.children()
					for (var i = (topSpaceDiv ? 1 : 0); i < children.length - (bottomSpaceDiv ? 1 : 0); i++) {
						if (children[i].offsetTop >= tbodyScrollTop) {
							return children[i];
						}
					}
				}

				function getLastVisibleChild() {
					var tbodyScrollBottom = tbody.scrollTop() + tbody.height();
					var children = tbody.children()
					for (var i = (topSpaceDiv ? 1 : 0); i < children.length - (bottomSpaceDiv ? 1 : 0); i++) {
						if (children[i].offsetTop + children[i].offsetHeight >= tbodyScrollBottom) {
							if (i > (topSpaceDiv ? 1 : 0)) return children[i - 1];
							return children[i];
						}
					}
					return children.length > (topSpaceDiv ? 1 : 0) + (bottomSpaceDiv ? 1 : 0) ? children[children.length - 1 - (bottomSpaceDiv ? 1 : 0)] : undefined;
				}

				$scope.keyPressed = function(event) {
					var fs = $scope.model.foundset;
					if (fs.selectedRowIndexes && fs.selectedRowIndexes.length > 0) {
						var selection = fs.selectedRowIndexes[0];
						if (event.keyCode == 33) { // PAGE UP KEY
							var child = getFirstVisibleChild();
							if (child) {
								if (child.previousSibling) child = child.previousSibling;
								var row_column = $(child).children().eq(0).data("row_column");
								if (row_column) {
									fs.selectedRowIndexes = [row_column.idxInFs];
								}
								child.scrollIntoView(false);
							}
						} else if (event.keyCode == 34) { // PAGE DOWN KEY
							var child = getLastVisibleChild();
							if (child) {
								// if this is the last visible child we should get the child after that to make visible.
								if (child.nextSibling) child = child.nextSibling;
								var row_column = $(child).children().eq(0).data("row_column");
								if (row_column) {
									fs.selectedRowIndexes = [row_column.idxInFs];
								}
								child.scrollIntoView(true);
							}
						} else if (event.keyCode == 38) { // ARROW UP KEY
							if (selection > 0) {
								fs.selectedRowIndexes = [selection - 1];
								if ( (fs.viewPort.startIndex) <= selection - 1) {
									toBottom = false;
								} else $scope.modifyPage(-1);
							}
							event.preventDefault();
						} else if (event.keyCode == 40) { // ARROW DOWN KEY
							if (selection < fs.serverSize - 1) {
								fs.selectedRowIndexes = [selection + 1];
								if ( (fs.viewPort.startIndex + fs.viewPort.size) > selection + 1) {
									toBottom = true;
								} else $scope.modifyPage(1);
							}
							event.preventDefault();
						} else if (event.keyCode == 13) { // ENTER KEY
							if ($scope.handlers.onCellClick) {
								$scope.handlers.onCellClick(selection + 1, null, fs.viewPort.rows[selection])
							}
						} else if (event.keyCode == 36) { // HOME
							if (fs.viewPort.startIndex > 0) { // see if we have the first record loaded
								function loadFirstRecordsIfNeeded() {
									// this can be executed delayed, after pending loads finish, so do check again if we still need to load bottom of foundset
									if (fs.viewPort.startIndex > 0) {
										var newLoadPromise = $scope.model.foundset.loadRecordsAsync(0, Math.min(fs.serverSize, getPreferredInitialViewportSize()));
										newLoadPromise.then(function() {
											// just in case server side foundset was not fully loaded and now that we accessed last part of it it already loaded more records
											runWhenThereIsNoPendingLoadRequest(loadFirstRecordsIfNeeded);
										});
										return newLoadPromise;
									} else if (fs.serverSize > 0) fs.requestSelectionUpdate([0]).then(function() {
											scrollToSelectionNeeded = true; /* just in case selection was already on first */
										});
								}
								runWhenThereIsNoPendingLoadRequest(loadFirstRecordsIfNeeded);
							} else if (fs.serverSize > 0) fs.requestSelectionUpdate([0]).then(function() {
									scrollToSelectionNeeded = true; /* just in case selection was already on first */
								});

							event.preventDefault()
							event.stopPropagation();
						} else if (event.keyCode == 35) { // END
							if (fs.viewPort.startIndex + fs.viewPort.size < fs.serverSize) { // see if we already have the last record loaded or not
								function loadLastRecordsIfNeeded() {
									// this can be executed delayed, after pending loads finish, so do check again if we still need to load bottom of foundset
									if (fs.viewPort.startIndex + fs.viewPort.size < fs.serverSize) {
										var firstIndexToLoad = Math.max(0, fs.serverSize - getPreferredInitialViewportSize());
										var newLoadPromise = $scope.model.foundset.loadRecordsAsync(firstIndexToLoad, fs.serverSize - firstIndexToLoad)
										newLoadPromise.then(function() {
											// just in case server side foundset was not fully loaded and now that we accessed last part of it it already loaded more records
											runWhenThereIsNoPendingLoadRequest(loadLastRecordsIfNeeded);
										});
										return newLoadPromise;
									} else fs.requestSelectionUpdate([fs.serverSize - 1]).then(function() {
											scrollToSelectionNeeded = true; /* just in case selection was already on first */
										});
								}
								runWhenThereIsNoPendingLoadRequest(loadLastRecordsIfNeeded);
							} else fs.requestSelectionUpdate([fs.serverSize - 1]).then(function() {
									scrollToSelectionNeeded = true; /* just in case selection was already on first */
								});

							event.preventDefault();
							event.stopPropagation();
						}
					}
				}

				function getDisplayValue(input, valuelist) {
					if (valuelist) {
						for (i = 0; i < valuelist.length; i++) {
							if (input === valuelist[i].realValue) {
								return valuelist[i].displayValue;
							}
						}
					}
					return input;
				}

				function updateTableRowSelectionClass(rowsFoundsetIdxArray, rowSelectionClass) {
					var trChildren = tbody.children();
					if (trChildren) {
						for (var i = 0; i < rowsFoundsetIdxArray.length; i++) {
							var trIndex = rowsFoundsetIdxArray[i] - renderedStartIndex;
							if (trIndex >= (topSpaceDiv ? 1 : 0) && trIndex < trChildren.length - (bottomSpaceDiv ? 1 : 0)) {
								var tr = trChildren.eq(trIndex + (topSpaceDiv ? 1 : 0)).get(0);
								if($scope.model.rowStyleClassDataprovider && $scope.model.rowStyleClassDataprovider[rowsFoundsetIdxArray[i]]) {
									tr.className = $scope.model.rowStyleClassDataprovider[rowsFoundsetIdxArray[i]] + ' ' + rowSelectionClass;
								} else {
									tr.className = rowSelectionClass;
								}
							}
						}
					}
				}

				function updateSelection(newValue, oldValue) {
					if (oldValue) {
						var toUnselect = oldValue.filter(function(i) {
							return !newValue || newValue.indexOf(i) < 0;
						})
						updateTableRowSelectionClass(toUnselect, "");
					}
					if (newValue) {
						var toSelect = newValue.filter(function(i) {
							return !oldValue || oldValue.indexOf(i) < 0;
						})
						updateTableRowSelectionClass(toSelect, $scope.model.selectionClass);
					}
				}

				function correctRenderViewportIfNeeded() {
					var changed = false;
					// don't allow rendered rows to shrink to less then 1 batch size due to foundset updates - as we might end up showing only one row
					// from a page for example while the page should actually be full of rows
					// also don't allow rendered to be outside of loaded viewport bounds or outside of allowed loaded bounds (calculating allowed is needed as
					// well because for example when the foundset is first shown server sends a viewport around the selection - that might not adhere to the
					// bounds of the page of selection - and we don't want to render records that are not in that page; the loaded bounds will be corrected
					// by adjustLoadedRowsIfNeeded() anyway but that will happen later/async)
					var vp = $scope.model.foundset.viewPort;
					var allowedBounds = calculateAllowedLoadedDataBounds(); // { startIdx, size }
					var correctedLoadedStartIdx = Math.max(vp.startIndex, allowedBounds.startIdx);
					var correctedLoadedSize = Math.min(vp.startIndex + vp.size, allowedBounds.startIdx + allowedBounds.size) - correctedLoadedStartIdx;
					var minRenderSize = Math.min(getInitialRenderSize(), correctedLoadedSize);

					if ( (renderedStartIndex < correctedLoadedStartIdx && renderedStartIndex + renderedSize <= correctedLoadedStartIdx) || (renderedStartIndex >= correctedLoadedStartIdx + correctedLoadedSize && renderedStartIndex + renderedSize > correctedLoadedStartIdx + correctedLoadedSize)) {
						// rendered rows are completely outside the loaded rows; set size to -1 so we will correct them & start fresh with a maximum of minRenderSize rows rendered
						renderedStartIndex = 0;
						renderedSize = -1;
					}
					if (renderedSize < minRenderSize || renderedStartIndex < correctedLoadedStartIdx || renderedStartIndex + renderedSize > correctedLoadedStartIdx + correctedLoadedSize) {
						// 1. the rendered viewport has to be greater - we have more rows, use them
						// OR
						// 2. the rendered viewport is outside of the loaded rows; so put it inside the loaded rows
						// center new rendered viewport around current/old rendered viewport as much as possible
						var computedInterval = centerIntervalAroundOldIntervalIfPossible(renderedStartIndex, renderedSize, correctedLoadedStartIdx, correctedLoadedSize, Math.max(minRenderSize, Math.min(renderedSize, correctedLoadedSize)));
						if (renderedStartIndex != computedInterval[0]) {
							renderedStartIndex = computedInterval[0];
							changed = true;
						}
						if (renderedSize != computedInterval[1]) {
							renderedSize = computedInterval[1];
							changed = true;
						}
					}

					if (changed && $log.debugEnabled && $log.debugLevel === $log.SPAM)
						$log.debug("svy extra table * correctRenderViewportIfNeeded did correct rendered interval to " + renderedStartIndex + ", " + renderedSize);

					return changed;
				}

				function getAverageRowHeight() {
					var averageRowHeight;
					if (renderedSize > 0) {
						var children = tbody.children();
						var firstChild = children.eq( (topSpaceDiv ? 1 : 0))[0];
						var lastChild = children.eq(children.length - 1 - (bottomSpaceDiv ? 1 : 0))[0];
						averageRowHeight = Math.floor( (lastChild.offsetTop + lastChild.offsetHeight - firstChild.offsetTop) / renderedSize);
					} else {
						averageRowHeight = 25; // it won't be relevant anyway; it is equal to the default minRowHeight from .spec
					}
					if (oldAverageRowHeight != averageRowHeight) {
						oldAverageRowHeight = averageRowHeight;
						if ($log.debugEnabled && $log.debugLevel === $log.SPAM) $log.debug("svy extra table * getAverageRowHeight changed to " + averageRowHeight);
					}
					return averageRowHeight;
				}

				function updateBatchSizesIfNeeded(averageRowHeight) {
					var oldBatchSizeForRenderingMoreRows = batchSizeForRenderingMoreRows;
					var oldBatchSizeForLoadingMoreRows = batchSizeForLoadingMoreRows;
					if (renderedSize > 0) {
						var visibleAreaRows = Math.ceil(tbody.height() / averageRowHeight);

						batchSizeForRenderingMoreRows = Math.max(Math.ceil(visibleAreaRows * magicRenderBatchQ), performanceSettings.minBatchSizeForRenderingMoreRows); // initially render rows for 3 times the visible area - so 1 above and 1 below the visible area, but then when scrolling and more rows are needed only render one more 'visible areas' of rows
						batchSizeForLoadingMoreRows = Math.max(Math.ceil(visibleAreaRows * magicLoadBatchQ), performanceSettings.minBatchSizeForLoadingMoreRows); // initially load rows for 5 times the visible area - so 2 above and 2 below initial visible area, but then when scrolling and more rows are needed only load two more 'visible areas' of rows
					} else {
						// just some defaults as we don't have enough info to calculate them
						batchSizeForRenderingMoreRows = Math.max(26, performanceSettings.minBatchSizeForRenderingMoreRows);
						batchSizeForLoadingMoreRows = Math.max(52, performanceSettings.minBatchSizeForLoadingMoreRows);
					}

					var batchSizesChanged = (oldBatchSizeForRenderingMoreRows != batchSizeForRenderingMoreRows || oldBatchSizeForLoadingMoreRows != batchSizeForLoadingMoreRows);
					if ($log.debugEnabled && $log.debugLevel === $log.SPAM && batchSizesChanged) {
						$log.debug("svy extra table * updateBatchSizesIfNeeded changed batch sizes for rendering and/or loading to (" + batchSizeForRenderingMoreRows + "," + batchSizeForLoadingMoreRows + ")");
					}
					return batchSizesChanged;
				}

				function updateTopAndBottomEmptySpace() {
					var spacingRowsAddedOrRemoved = false;
					var allowedBounds = calculateAllowedLoadedDataBounds();

					// calculate average rendered row height
					var averageRowHeight = getAverageRowHeight();

					updateBatchSizesIfNeeded(averageRowHeight);

					if (renderedStartIndex > allowedBounds.startIdx) {
						// there are records on top that are not yet rendered; add an empty div as the first row to simulate the height
						// that the non-rendered rows should use - for more natural scrolling; if we already have that div just recalculate it's height
						if (!topSpaceDiv) {
							var topTR = document.createElement("tr");
							var topTD = document.createElement("td");
							topSpaceDiv = document.createElement("div");
							topTD.appendChild(topSpaceDiv);
							topTR.appendChild(topTD);
							tbody.prepend(topTR);

							topSpaceDiv = $(topSpaceDiv);
							spacingRowsAddedOrRemoved = true;

							if ($log.debugEnabled && $log.debugLevel === $log.SPAM)
								$log.debug("svy extra table * updateTopAndBottomEmptySpace added top empty space row");
						}
						var previousHeight;
						if ($log.debugEnabled && $log.debugLevel === $log.SPAM) previousHeight = topSpaceDiv.height();

						topSpaceDiv.height(averageRowHeight * (renderedStartIndex - allowedBounds.startIdx));

						if ($log.debugEnabled && $log.debugLevel === $log.SPAM && previousHeight != topSpaceDiv.height())
							$log.debug("svy extra table * updateTopAndBottomEmptySpace changed top empty space to: " + topSpaceDiv.height());
					} else if (topSpaceDiv) {
						topSpaceDiv.parent().parent().remove();
						topSpaceDiv = null;
						spacingRowsAddedOrRemoved = true;

						if ($log.debugEnabled && $log.debugLevel === $log.SPAM)
							$log.debug("svy extra table * updateTopAndBottomEmptySpace removed top empty space row");
					}

					if (renderedStartIndex + renderedSize < allowedBounds.startIdx + allowedBounds.size) {
						// there are records on top that are not yet rendered; add an empty div as the first row to simulate the height
						// that the non-rendered rows should use - for more natural scrolling; if we already have that div just recalculate it's height
						if (!bottomSpaceDiv) {
							var bottomTR = document.createElement("tr");
							var bottomTD = document.createElement("td");
							bottomSpaceDiv = document.createElement("div");
							bottomTD.appendChild(bottomSpaceDiv);
							bottomTR.appendChild(bottomTD);
							tbody.append(bottomTR);

							bottomSpaceDiv = $(bottomSpaceDiv);
							spacingRowsAddedOrRemoved = true;

							if ($log.debugEnabled && $log.debugLevel === $log.SPAM)
								$log.debug("svy extra table * updateTopAndBottomEmptySpace added bottom empty space row");
						}
						var previousBottomHeight;
						if ($log.debugEnabled && $log.debugLevel === $log.SPAM) previousBottomHeight = bottomSpaceDiv.height();

						bottomSpaceDiv.height(averageRowHeight * (allowedBounds.startIdx + allowedBounds.size - renderedStartIndex - renderedSize));

						if ($log.debugEnabled && $log.debugLevel === $log.SPAM && previousBottomHeight != bottomSpaceDiv.height())
							$log.debug("svy extra table * updateTopAndBottomEmptySpace changed bottom empty space to: " + bottomSpaceDiv.height());
					} else if (bottomSpaceDiv) {
						bottomSpaceDiv.parent().parent().remove();
						bottomSpaceDiv = null;
						spacingRowsAddedOrRemoved = true;

						if ($log.debugEnabled && $log.debugLevel === $log.SPAM)
							$log.debug("svy extra table * updateTopAndBottomEmptySpace removed bottom empty space row");
					}

					return spacingRowsAddedOrRemoved;
				}

				// changes is something like { rowUpdates: rowUpdates, oldStartIndex: oldStartIndex, oldSize : oldSize }
				function updateRenderedRows(changes, offset) {
					if ($log.debugEnabled && $log.debugLevel === $log.SPAM)
						$log.debug("svy extra table * updateRenderedRows called with: " + JSON.stringify(changes) + ", " + JSON.stringify(offset));

					var children = tbody.children(); // contains rendered rows + optionally the top empty space and bottom empty space rows
					var childrenListChanged = false;
					var startIndex = 100000000; // starting point where rows need to be updated relative to new rendered/UI viewport
					var endIndex = 0; // end index of rows to be updated relative to new rendered/UI viewport
					var newRowsToBeRenderedBefore = 0; // number of rows to be added/rendered before previously rendered ones
					var rowOffSet = offset ? offset : 0; // offset of renderedStartIndex in/relative to model.foundset.viewport

					var childIdxToScrollTo = -1; // relative to rendered rows
					var alignToTopWhenScrolling = false;
					var forceScroll = false;

					var vp = $scope.model.foundset.viewPort;
					var correctRenderedBoundsAtEnd = false; // if rendered rows needed correction update them all again (I don't call this at the beginning of the method if we have arguments because that might affect what changes and offset were supposed to do based on current renderStartIndex and renderedSize; so I don't want to correct those here but rather at the end)

					// if there are changes but the renderedStartIndex of the last time doesn't fit at all in this index anymore
					// then the viewport is completely changed and we do need a full render
					if (changes && (renderedStartIndex >= vp.startIndex && renderedStartIndex < (vp.startIndex + vp.size))) {
						// this is hit when row/column viewport updates are happening. we just need to re-render/add/remove the affected TDs in rendered viewport
						// note that TDs are always relative to renderedStartIndex of foundset (so the rendered viewport))

						// avoid unneeded re-rendering when user is scrolling up and we load extra records from server - which arrive as an insert that just prepends rows to the viewport;
						// that insert can be ignored completely as it is outside of the renderedViewport (it's not a real insert in the foundset, just insert in the viewport array with size growing)
						// the scrollHandler code will call updateRenderedRows(null, newOffset) to render loaded new rows if needed
						var rowUpdates = changes.rowUpdates; // this should never be undefined/null
						if (rowUpdates.length == 1 && rowUpdates[0].type == 1 && rowUpdates[0].startIndex == 0 && changes.oldStartIndex != undefined && changes.oldSize != undefined && changes.oldStartIndex == vp.startIndex + rowUpdates[0].rows.length && changes.oldSize == vp.size - rowUpdates[0].rows.length) {
							// we check above changes.oldStartIndex != undefined && changes.oldSize != undefined because those are provided only starting with Servoy 8.1.2 - and I don't want to create a separate branch on servoy-extra just for this scenario
							if ($log.debugEnabled && $log.debugLevel === $log.SPAM)
								$log.debug("svy extra table * updateRenderedRows ignored because it is just an extra-load on top; rendered viewport is not affected although it might be corrected by scrollhandler later");
							return; // rendered rows are not affected; do nothing
						}

						// first make sure render/UI viewport bounds do not exceed model.foundset.viewport bounds;
						// any further corrections in NEEDED row bounds for display are done afterwards - if needed - in the scroll listener
						renderedStartIndex = Math.max(renderedStartIndex, vp.startIndex);
						renderedSize = Math.min(renderedSize, vp.startIndex + vp.size - renderedStartIndex);
						rowOffSet = renderedStartIndex - vp.startIndex;

						for (var i = 0; i < rowUpdates.length; i++) {
							var rowUpdate = rowUpdates[i]; // rowUpdate indexes are obviously relative to model.foundset.viewport
							if (rowUpdate.startIndex < rowOffSet + startIndex) startIndex = rowUpdate.startIndex - rowOffSet;
							var updateEndIndex = rowUpdate.endIndex - rowOffSet;

							if (rowUpdate.type == 1) {
								// insert
								// if it's an insert then insert position end (so rowUpdate.endIndex) by convention really means "new viewport size" not "endIndex"; endIndex == viewPort.size (that is what the server sends for insert operations)
								// so based on that and on how updateEndIndex is calculated above
								updateEndIndex--;
							} else if (rowUpdate.type == 2) {
								// delete
								updateEndIndex = vp.size - 1 - rowOffSet; // update all after startIndex
							}
							if (updateEndIndex > endIndex) endIndex = updateEndIndex;
						}
						endIndex = Math.min(renderedSize - 1, endIndex); // we don't need to re-render more rows after rendered viewport
						startIndex = Math.max(0, startIndex); // we don't need to re-render more rows before rendered viewport

						correctRenderedBoundsAtEnd = true;
					} else if (offset >= 0) {
						// offset is given when scrolling up, so new rows will be prepended; see how many (old offset - newOffset)
						newRowsToBeRenderedBefore = (renderedStartIndex - vp.startIndex) - offset; // this should always be > 0

						renderedStartIndex = vp.startIndex + offset; // update renderedStartIndex; renderedSize was already updated by scroll handler code...

						correctRenderedBoundsAtEnd = true;
					} else {
						// called when a "full" render needs to be done
						correctRenderViewportIfNeeded();
						var firstSelected = $scope.model.foundset.selectedRowIndexes ? $scope.model.foundset.selectedRowIndexes[0] : 0;

						if (scrollToSelectionNeeded && vp.startIndex <= firstSelected && (vp.startIndex + vp.size) > firstSelected) {
							var formStartToSelection = firstSelected - vp.startIndex;

							// restrict rendered rows to loaded rows that are within allowed bounds (for example first show of a foundset will get from server
							// an interval around selection that might span multiple pages and we only want to render rows from current page)
							var allowedBounds = calculateAllowedLoadedDataBounds(); // { startIdx, size }
							var allowedRowOffset = Math.max(0, allowedBounds.startIdx - vp.startIndex); // so relative to loaded viewport
							var allowedRenderSize = Math.min(vp.startIndex + vp.size, allowedBounds.startIdx + allowedBounds.size) - allowedRowOffset - vp.startIndex;

							// selection is in the viewport, try to make sure that is visible and centered in rendered viewport
							var computedInterval = centerIntervalAroundOldIntervalIfPossible(formStartToSelection, 0, allowedRowOffset, allowedRenderSize, renderedSize);
							rowOffSet = computedInterval[0];
							renderedSize = computedInterval[1];

							childIdxToScrollTo = formStartToSelection - rowOffSet; // new selected row rendered index
							alignToTopWhenScrolling = !toBottom;
							scrollToSelectionNeeded = false; // now reset the flag so that it is only set back to true on purpose
							if ($log.debugEnabled && $log.debugLevel === $log.SPAM)
								$log.debug("svy extra table * updateRenderedRows; scroll will be done, scrollToSelectionNeeded = false");
						} else {
							// re-render all
							rowOffSet = renderedStartIndex - vp.startIndex;

							if (renderedSize > 0) {
								// if previously first visible child is no longer part of the rendered rows after full re-render, scroll to top rendered row (changing page relies of this to show first row in new page)
								var firstVisibleChild = getFirstVisibleChild(); // get first visible DOM node
								// take the index in loaded viewport from dom element (to make sure we really target the same row
								// no matter what renderedSize and renderedStartIndex are (they might have been altered before calling this method))
								// so we can't rely on the fact that the Nth DOM child is the Nth relative to renderedStartIndex
								var indexInFoundset = getRowIndexInFoundset(firstVisibleChild);
								if (indexInFoundset >= 0) {
									var indexInViewport = getViewportIndexFromFoundsetIndex(indexInFoundset);
									if (indexInViewport >= 0) {
										var idxOfRowInRendered = indexInViewport - rowOffSet; // child will be relative to rendered obviously
										if (idxOfRowInRendered < 0 || idxOfRowInRendered >= renderedSize) childIdxToScrollTo = 0; // in case previously shown element will no longer be a part of rendered viewport
									} else childIdxToScrollTo = 0;
								} else childIdxToScrollTo = 0;

								if (childIdxToScrollTo == 0) {
									alignToTopWhenScrolling = true;
									forceScroll = true;
								}
							}
						}

						startIndex = 0;
						endIndex = renderedSize - 1;

						renderedStartIndex = vp.startIndex + rowOffSet;
					}

					var formatFilter = $filter("formatFilter");
					var columns = $scope.model.columns;

					if ($log.debugEnabled && $log.debugLevel === $log.SPAM) {
						$log.debug("svy extra table * updateRenderedRows; renderedStartIndex = " + renderedStartIndex + " & renderedSize = " + renderedSize);
						if (startIndex <= endIndex) $log.debug("svy extra table * updateRenderedRows will rerender from (relative to viewport) " + (rowOffSet + startIndex) + " up to " + (rowOffSet + endIndex));
					}

					var topEmptySpaceRowCount = (topSpaceDiv ? 1 : 0); // access the correct index for rows if we have the empty space row present
					var bottomEmptySpaceRowCount = (bottomSpaceDiv ? 1 : 0);

					function appendRowSelectionClassName(trEl, idxInFoundset) {
						var selectionClass =  $scope.model.foundset.selectedRowIndexes.indexOf(idxInFoundset) != -1 ? $scope.model.selectionClass : "";
						if (trEl.className) {
							trEl.className += ' ' + selectionClass;
						}
						else {
							trEl.className = selectionClass;
						}
					}

					if (newRowsToBeRenderedBefore > 0) {
						var beforeEl = children.eq(topEmptySpaceRowCount); // dom element before which the new rows should be appended (first row rendered previously if any is available, otherwise bottom space div or null)
						if (!beforeEl || beforeEl.length == 0) beforeEl = null; // append last (before == null) as there is nothing after it
						else beforeEl = beforeEl[0]; // get DOM node in front of which we should insert

						// rows will be prepended to current ones on top
						for (var j = 0; j < newRowsToBeRenderedBefore; j++) {
							// as trChildren is relative to rendered viewport, it can only grow (have missing rows) or shrink at the end; if changes
							// happen before it, the data is updated in those cells, no real dom Node inserts have to happen in specific indexes in
							// the rendered viewpot
							var insertedEl = createTableRow(columns, j + rowOffSet, formatFilter);
							tbody[0].insertBefore(insertedEl, beforeEl);
							appendRowSelectionClassName(insertedEl, renderedStartIndex + j);
						}

						children = tbody.children();
						childrenListChanged = false;
					}

					for (var j = startIndex; j <= endIndex; j++) {
						var rowIdxInFoundsetViewport = j + rowOffSet;
						var trElement = children.eq(j + topEmptySpaceRowCount);

						var bottomSpaceRowReached = (bottomSpaceDiv && (!trElement || trElement.length == 0 || trElement.is(bottomSpaceDiv.parent().parent())));
						var trChildren = trElement.children();
						if (bottomSpaceRowReached || trChildren.length == 0) {
							// if we reached the end (bottomSpaceDiv if available or really there are no more <tr>s then create the newly rendered row(s) as needed and append or insert them before bottom space div row)
							trElement = createTableRow(columns, rowIdxInFoundsetViewport, formatFilter);

							if (bottomSpaceRowReached) tbody[0].insertBefore(trElement, bottomSpaceDiv.parent().parent()[0]);
							else tbody[0].appendChild(trElement);

							trElement = $(trElement);
							childrenListChanged = true;
						} else {
							if($scope.model.rowStyleClassDataprovider && $scope.model.rowStyleClassDataprovider[rowIdxInFoundsetViewport]) {
								trElement.get(0).className = $scope.model.rowStyleClassDataprovider[rowIdxInFoundsetViewport];
							}
							for (var c = columns.length; --c >= 0;) {
								var column = columns[c];
								var td = trChildren.eq(c);
								td.data('row_column', { idxInFs: getFoundsetIndexFromViewportIndex(rowIdxInFoundsetViewport), column: c });
								var tdClass = 'c' + c;
								if (column.styleClass) {
									tdClass += ' ' + column.styleClass;
								}
								if (column.styleClassDataprovider && column.styleClassDataprovider[rowIdxInFoundsetViewport]) {
									tdClass += ' ' + column.styleClassDataprovider[rowIdxInFoundsetViewport];
								}
								td[0].className = tdClass;
								var value = column.dataprovider ? column.dataprovider[rowIdxInFoundsetViewport] : null;
								var imageMode = value ? value.url : false;
								var divChild = td.children("div");
								if (imageMode && divChild.length == 1) {
									divChild.remove();
									var img = document.createElement("IMG");
									td[0].appendChild(img);
									divChild = td.children("div");
								}
								if (divChild.length == 1) {
									// its text node
									value = getDisplayValue(value, column.valuelist);
									value = formatFilter(value, column.format.display, column.format.type);
									divChild.text(value)
								} else {
									var imgChild = td.children("img");
									if (imgChild.length == 1) {
										if (!value) {
											imgChild[0].setAttribute("src", "");
										} else imgChild[0].setAttribute("src", column.dataprovider[rowIdxInFoundsetViewport].url);
									} else {
										console.log("illegal state should be div or img")
									}
								}
							}
						}

						if (trElement.get(0)) appendRowSelectionClassName(trElement.get(0), renderedStartIndex + j);
					}

					if (childrenListChanged) {
						childrenListChanged = false;
						children = tbody.children();
					}
					if (children.length - topEmptySpaceRowCount - bottomEmptySpaceRowCount > renderedSize) {
						if ($log.debugEnabled && $log.debugLevel === $log.SPAM)
							$log.debug("svy extra table * updateRenderedRows will delete rendered rows from " + (rowOffSet + renderedSize) + " up to " + (rowOffSet + children.length - 1));

						for (var i = children.length - bottomEmptySpaceRowCount; --i >= renderedSize + topEmptySpaceRowCount;) {
							children.eq(i).remove();
							childrenListChanged = true;
						}
					}

					childrenListChanged = updateTopAndBottomEmptySpace() || childrenListChanged;
					topEmptySpaceRowCount = (topSpaceDiv ? 1 : 0);
					bottomEmptySpaceRowCount = (bottomSpaceDiv ? 1 : 0);

					if (childrenListChanged) {
						childrenListChanged = false;
						children = tbody.children();
					}

					if (childIdxToScrollTo >= 0) {
						var scrollToChild = children.eq(childIdxToScrollTo + topEmptySpaceRowCount)[0];
						if (scrollToChild) {
							var tbodyBounds = tbody[0].getBoundingClientRect();
							var childBounds = scrollToChild.getBoundingClientRect();
							if (forceScroll || childBounds.top < tbodyBounds.top || childBounds.bottom > tbodyBounds.bottom) {
								scrollToChild.scrollIntoView(alignToTopWhenScrolling)
							}
						}
					}

					if (correctRenderedBoundsAtEnd) {
						if (correctRenderViewportIfNeeded()) updateRenderedRows(null);
					}
				}

				var columnCSSRules = [];
				function updateTableColumnStyleClass(columnIndex, style) {
					if (!columnCSSRules[columnIndex]) {
						var ss = document.styleSheets;
						var clsName = "#table_" + $scope.model.svyMarkupId + " .c" + columnIndex;
						var targetStyleSheet;

						for (var i = 0; i < ss.length; i++) {
							if (ss[i].href != null) continue;
							if (!targetStyleSheet) targetStyleSheet = ss[i];
							var rules = ss[i].cssRules || ss[i].rules;

							for (var j = 0; j < rules.length; j++) {
								if (rules[j].selectorText == clsName) {
									columnCSSRules[columnIndex] = rules[j];
									break;
								}
							}
						}
						if (!columnCSSRules[columnIndex]) {
							if (!targetStyleSheet) {
								targetStyleSheet = document.createElement('style');
								targetStyleSheet.type = 'text/css';
								document.getElementsByTagName('head')[0].appendChild(targetStyleSheet);
							}
							var rules = targetStyleSheet.cssRules || targetStyleSheet.rules;
							targetStyleSheet.insertRule(clsName + '{}', rules.length);
							columnCSSRules[columnIndex] = rules[rules.length - 1];
							columnCSSRules[columnIndex].style["height"] = $scope.model.minRowHeight
						}
					}

					for (var p in style) {
						columnCSSRules[columnIndex].style[p] = style[p];
					}

				}
				// cache for the current set style class names, used in the columns property watcher.
				var columnStyleClasses = [];
				function updateColumnStyleClass() {
					var columns = $scope.model.columns;
					for (var c = 0; c < columns.length; c++) {
						if (columns[c].styleClass != columnStyleClasses[c]) {
							generateTemplate();
							break;
						}
					}
				}
				var foundsetListener = null;
				function generateTemplate(full) {
					if ($log.debugEnabled && $log.debugLevel === $log.SPAM)
						$log.debug("svy extra table * generateTemplate called");
					correctRenderViewportIfNeeded();

					var columns = $scope.model.columns;
					if (!columns || columns.length == 0) return;
					var tbodyJQ = tbody;
					var tblHead = $element.find("thead");
					if (tbodyJQ.length == 0 || $(tblHead).height() <= 0) {
						if ($element.closest("body").length > 0) $timeout(generateTemplate);
						return;
					}
					var rows = $scope.model.foundset.viewPort.rows;

					if (foundsetListener == null) {

						foundsetListener = function(rowUpdates, oldStartIndex, oldSize) {
							$scope.$evalAsync(function() {
								adjustLoadedRowsIfNeeded();
								updateRenderedRows({ rowUpdates: rowUpdates, oldStartIndex: oldStartIndex, oldSize: oldSize });
							})
						}
						$scope.model.foundset.addChangeListener(foundsetListener)
					}
					for (var c = 0; c < columns.length; c++) {
						updateTableColumnStyleClass(c, getCellStyle(c));
						columnStyleClasses[c] = columns[c].styleClass;
					}
					if (tbodyJQ.children().length == (topSpaceDiv ? 1 : 0) + (bottomSpaceDiv ? 1 : 0) || full) {
						var formatFilter = $filter("formatFilter");
						var tbodyOld = tbodyJQ[0];
						var tbodyNew = document.createElement("TBODY");
						tbody = $(tbodyNew);
						topSpaceDiv = null;
						bottomSpaceDiv = null;

						updateTBodyStyle(tbodyNew);
						renderedSize = Math.min(renderedSize, rows.length);
						var firstSelected = $scope.model.foundset.selectedRowIndexes ? $scope.model.foundset.selectedRowIndexes[0] : 0;
						var startRow = 0;
						var formStartToSelection = firstSelected - $scope.model.foundset.viewPort.startIndex
						if (formStartToSelection < $scope.model.foundset.viewPort.size && formStartToSelection > renderedSize) {
							// if the selection is in the viewport and it will not be rendered because it falls out of the max rows
							// adjust the startRow to render
							startRow = Math.floor(formStartToSelection - renderedSize / 2) + 1;
							if (startRow + renderedSize > $scope.model.foundset.viewPort.size) {
								startRow = $scope.model.foundset.viewPort.size - renderedSize;
							}
						}
						renderedStartIndex = $scope.model.foundset.viewPort.startIndex + startRow
						var rowEnding = startRow + renderedSize
						for (var r = startRow; r < rowEnding; r++) {
							tbodyNew.appendChild(createTableRow(columns, r, formatFilter));
						}
						tbodyOld.parentNode.replaceChild(tbodyNew, tbodyOld)
						updateTopAndBottomEmptySpace();

						// this is called from a scroll listener to see if more records need to be rendered or loaded
						// but also afterwards when rows are loaded due to scroll to update rendered viewport
						var scrollHandler = function() {
							var vp = $scope.model.foundset.viewPort;
							var renderedStartIndexInLoaded = renderedStartIndex - vp.startIndex; // so relative to loaded viewport, not to start of foundset
							var renderedSizeBefore = renderedSize;

							// see if more rows are needed on top
							if (tbody.scrollTop() - (topSpaceDiv ? topSpaceDiv.height() : 0) < tbody.height()) {
								// the following code should mirror the scroll down behavior

								// scroll up behavior
								// for none paging the minimal row index is 0; for paging it is the first index on current page
								var firstIndexAllowedOnScrollUp = 0;
								if ($scope.showPagination()) {
									// paging mode calculate max size of the current viewPort
									firstIndexAllowedOnScrollUp = $scope.model.pageSize * ($scope.model.currentPage - 1);
								}

								// check if the current first rendered row index is bigger then what the minimal would be
								if (renderedStartIndex > firstIndexAllowedOnScrollUp) {
									if ($log.debugEnabled && $log.debugLevel === $log.SPAM)
										$log.debug("svy extra table * scrollHandler more records need to be rendered on top");

									// grow rendered rows on top as much as possible with current loaded rows (if rows are already loaded on top but not yet rendered)
									// so we render as much as we can right away
									renderedSize = Math.min(renderedSize + batchSizeForRenderingMoreRows, renderedSize + renderedStartIndexInLoaded);
									var addedRows = renderedSize - renderedSizeBefore;
									// calculate the offset of the rendered rows inside the loaded ones
									var offset = Math.max(0, renderedStartIndexInLoaded - addedRows);

									// see if more rows need to be loaded from server (there is less then one page of rendered rows available but there are more rows to be loaded on top)
									if (vp.startIndex > firstIndexAllowedOnScrollUp && (renderedStartIndex - vp.startIndex) < batchSizeForRenderingMoreRows) {
										if ($log.debugEnabled && $log.debugLevel === $log.SPAM)
											$log.debug("svy extra table * scrollHandler more records need to be loaded on top");
										// if a previous scroll down already requested extra records, wait for that to happen
										// and then recompute everything based on the new viewport - to see if loading more is still needed (so scrollHandler() will be called)
										// else if there is no pending load, ask for the extra records
										runWhenThereIsNoPendingLoadRequest(function() {
												var newLoadingPromise = $scope.model.foundset.loadExtraRecordsAsync(-Math.min(batchSizeForLoadingMoreRows, vp.startIndex - firstIndexAllowedOnScrollUp));
												newLoadingPromise.then(scrollHandler); // check if rendered viewport needs to be updated again after more rows get loaded
												return newLoadingPromise;
											}, scrollHandler);
									}
									if (addedRows != 0) {
										updateRenderedRows(null, offset); // this can/will update renderedStartIndex to match the given offset
										$timeout(scrollHandler, 0); // check again just in case the render resulted in the need for more rows according to current scroll position; but do it in a timeout so that we don't block the UI completely if many renders need to be done one after the other due to a very fast scroll (drag of scroll knob)
									}
								}
							} // no else here because we don't even check if it was a scroll up or scroll down; we then just check if we need more rows either top or bottom

							// see if more rows are needed at bottom
							if ( (tbody.scrollTop() + 2 * tbody.height()) > (tbody[0].scrollHeight - (bottomSpaceDiv ? bottomSpaceDiv.height() : 0))) {
								// the following code should mirror the scroll up behavior

								// scroll down behavior; it seems that less then one more visible page is rendered; render more records below it (if available; also load  from server more records if needed)
								var lastIndexAllowedOnScrollDown; // absolute index in foundset

								// calculate max row index (relative to foundset) that can be requested, for paging it is the last index in the current page, for non-paging it is serverSize - 1
								if ($scope.showPagination()) {
									lastIndexAllowedOnScrollDown = Math.min($scope.model.pageSize * $scope.model.currentPage, $scope.model.foundset.serverSize) - 1;
								} else {
									lastIndexAllowedOnScrollDown = $scope.model.foundset.serverSize - 1;
								}

								// see if scroll should render more rows
								if ( (renderedStartIndex + renderedSize - 1) < lastIndexAllowedOnScrollDown) {
									if ($log.debugEnabled && $log.debugLevel === $log.SPAM)
										$log.debug("svy extra table * scrollHandler more records need to be rendered below");

									// render one more batch of rows or as many as currently available in loaded viewport - if there are not enough loaded or available
									renderedSize = Math.min(renderedSize + batchSizeForRenderingMoreRows, vp.size - renderedStartIndexInLoaded);

									// see if we also need to request one more batch of records from server due to scrolling down
									var currentLastLoadedIndex = vp.startIndex + vp.size - 1;
									if (currentLastLoadedIndex < lastIndexAllowedOnScrollDown && (currentLastLoadedIndex - (renderedStartIndex + renderedSize)) < batchSizeForRenderingMoreRows) {
										if ($log.debugEnabled && $log.debugLevel === $log.SPAM)
											$log.debug("svy extra table * scrollHandler more records need to be loaded below");

										// if a previous scroll down already requested extra records, wait for that to happen
										// and then recompute everything based on the new viewport - to see if loading more is still needed (so scrollHandler() will be called)
										// else if there is no pending load, ask for the extra records
										runWhenThereIsNoPendingLoadRequest(function() {
												var newLoadingPromise = $scope.model.foundset.loadExtraRecordsAsync(Math.min(batchSizeForLoadingMoreRows, lastIndexAllowedOnScrollDown - currentLastLoadedIndex));
												newLoadingPromise.then(scrollHandler); // check if rendered viewport needs to be updated again after more rows get loaded
												return newLoadingPromise;
											}, scrollHandler);
									}

									if (renderedSize != renderedSizeBefore) {
										// call update table so that any new rows that need to be rendered are rendered (if viewport already had some more rows loaded but they were not yet rendered)
										updateRenderedRows({ rowUpdates: [{ startIndex: renderedStartIndexInLoaded + renderedSizeBefore, endIndex: renderedStartIndexInLoaded + renderedSize - 1, type: 0 }], oldStartIndex: vp.startIndex, oldSize : vp.size }); // endIndex is inclusive
										$timeout(scrollHandler, 0); // check again just in case the render resulted in the need for more rows according to current scroll position; but do it in a timeout so that we don't block the UI completely if many renders need to be done one after the other due to a very fast scroll (drag of scroll knob)
									}
								}
							}
						};

						tbody.scroll(scrollHandler); // register as scroll listener
						scrollToRenderedIfNeeded();
					} else {
						updateTBodyStyle(tbodyJQ[0]);
						updateRenderedRows(null);
					}

					onTableRendered();
				}

				function createTableRow(columns, idxInLoaded, formatFilter) {
					var tr = document.createElement("TR");
					if($scope.model.rowStyleClassDataprovider && $scope.model.rowStyleClassDataprovider[idxInLoaded]) {
						tr.className = $scope.model.rowStyleClassDataprovider[idxInLoaded];
					}
					for (var c = 0; c < columns.length; c++) {
						var column = columns[c];
						var td = document.createElement("TD");
						$(td).data('row_column', { idxInFs: getFoundsetIndexFromViewportIndex(idxInLoaded), column: c });
						var tdClass = 'c' + c;
						if (column.styleClass) {
							tdClass += ' ' + column.styleClass;
						}
						if (column.styleClassDataprovider && column.styleClassDataprovider[idxInLoaded]) {
							tdClass += ' ' + column.styleClassDataprovider[idxInLoaded];
						}
						td.className = tdClass;
						tr.appendChild(td);
						if (column.dataprovider && column.dataprovider[idxInLoaded] && column.dataprovider[idxInLoaded].url) {
							var img = document.createElement("IMG");
							img.setAttribute("src", column.dataprovider[idxInLoaded].url);
							td.appendChild(img);
						} else {
							var div = document.createElement("DIV");
							var value = column.dataprovider ? column.dataprovider[idxInLoaded] : null;
							value = getDisplayValue(value, column.valuelist);
							if (column.format) value = formatFilter(value, column.format.display, column.format.type);
							var txt = document.createTextNode(value ? value : "");
							div.appendChild(txt);
							td.appendChild(div);
						}
					}
					return tr;
				}

				var tableStyle = { };
				$scope.getTableStyle = function() {
					tableStyle.width = autoColumns.count > 0 ? getComponentWidth() + "px" : tableWidth + "px";
					return tableStyle;
				}

				var tHeadStyle = { }
				$scope.getTHeadStyle = function() {
					if ($scope.model.enableSort || $scope.handlers.onHeaderClick) {
						tHeadStyle.cursor = "pointer";
					}
					tHeadStyle.width = autoColumns.count > 0 ? getComponentWidth() + "px" : tableWidth + "px";
					tHeadStyle.left = tableLeftOffset + "px";
					return tHeadStyle;
				}

				function updateTBodyStyle(tBodyEl) {
					var tBodyStyle = { };
					var componentWidth = getComponentWidth();
					tBodyStyle.width = componentWidth + "px";
					if (tableWidth < componentWidth) {
						tBodyStyle.overflowX = "hidden";
					}
					var tbl = $element.find("table:first");
					var tblHead = tbl.find("thead");
					if ($(tblHead).is(":visible")) {
						tBodyStyle.top = $(tblHead).height() + "px";
					}
					if ($scope.showPagination()) {
						var pagination = $element.find("ul:first");
						if (pagination.get().length > 0) {
							tBodyStyle.marginBottom = ($(pagination).height() + 2) + "px";
						}
					}

					for (var p in tBodyStyle) {
						tBodyEl.style[p] = tBodyStyle[p];
					}
				}
				var columnStyleCache = []
				$scope.getColumnStyle = function(column) {
					var columnStyle = columnStyleCache[column];
					if (columnStyle) return columnStyle;
					columnStyle = { overflow: "hidden" };
					columnStyleCache[column] = columnStyle;
					var w = getNumberFromPxString($scope.model.columns[column].width);
					if (w > -1) {
						columnStyle.minWidth = columnStyle.maxWidth = columnStyle.width = w + "px";
					} else if ($scope.model.columns[column].width) {
						columnStyle.width = $scope.model.columns[column].width;
					} else {
						columnStyle.minWidth = columnStyle.maxWidth = columnStyle.width = Math.floor( (getComponentWidth() - tableWidth) / autoColumns.count) + "px";
					}
					return columnStyle;
				}

				function getCellStyle(column) {
					var cellStyle = { overflow: "hidden" };
					if (column < $scope.model.columns.length) {
						var w = getNumberFromPxString($scope.model.columns[column].width);
						if ($scope.model.columns[column].autoResize || w < 0) {
							var tbl = $element.find("table:first");
							var headers = tbl.find("th");
							w = $(headers.get(column)).outerWidth(false);
						}
						if (w > -1) {
							cellStyle.minWidth = w + "px";
							cellStyle.width = w + "px";
							cellStyle.maxWidth = w + "px";
						} else if ($scope.model.columns[column].width) {
							cellStyle.width = $scope.model.columns[column].width;
						}
					}
					return cellStyle;
				}
				// watch the table header if there are any column width changes/
				// if that happens flush the cellStyles cache
				$scope.$watch(function() {
						var array = "";
						var columns = $scope.model.columns;
						if (!columns || columns.length == 0) return array;
						var tbl = $element.find("table:first");
						var headers = tbl.find("th");
						for (var column = columns.length; --column >= 0;) {
							array += $(headers.get(column)).outerWidth(false);
						}
						return array;
					}, function(newValue, oldValue) {
						columnStyleCache = [];
					})

				var currentSortClass = [];
				var sortClassUpdateTimer;
				$scope.getSortClass = function(column) {
					var sortClass = "table-servoyextra-sort-hide";
					if ($scope.model.enableSort) {
						var direction;
						var isGetSortFromSQL = $scope.model.sortColumnIndex < 0;
						if (column == $scope.model.sortColumnIndex) {
							direction = $scope.model.sortDirection;
							if (!direction) {
								isGetSortFromSQL = true;
							}
						}
						if (isGetSortFromSQL) {
							if ($scope.model.foundset && $scope.model.foundset.sortColumns && $scope.model.columns[column].dataprovider) {
								var sortCol = $scope.model.columns[column].dataprovider.idForFoundset;
								var sortColumnsA = $scope.model.foundset.sortColumns.split(" ");

								if (sortCol == sortColumnsA[0]) {
									direction = sortColumnsA[1].toLowerCase() == "asc" ? "up" : "down";
								}
							}
						}

						if (direction) {
							sortClass = "table-servoyextra-sort-show-" + direction + " " + $scope.model["sort" + direction + "Class"];
						}
					}
					if (currentSortClass.length <= column || currentSortClass[column] != sortClass) {
						if (sortClassUpdateTimer) $timeout.cancel(sortClassUpdateTimer);
						sortClassUpdateTimer = $timeout(function() {
								updateTBodyStyle(tbody[0]);
							}, 50);
						currentSortClass[column] = sortClass;
					}
					return sortClass;
				}

				$scope.getLayoutStyle = function() {
					var layoutStyle = { };
					var isAbsolute = $scope.$parent.formProperties && $scope.$parent.formProperties.absoluteLayout;
					if (isAbsolute) {
						layoutStyle.position = "absolute";
						layoutStyle.height = "100%";
					} else {
						layoutStyle.position = "relative";
						if ($scope.model.columns) {
							layoutStyle.height = $scope.model.responsiveHeight + "px";
						}
					}
					return layoutStyle;
				}

				$scope.showEditorHint = function() {
					return (!$scope.model.columns || $scope.model.columns.length == 0) && $scope.svyServoyapi.isInDesigner();
				}

				var skipOnce = false;
				if ($scope.handlers.onFocusGainedMethodID) {
					$scope.onFocusGained = function(event) {
						if (!skipOnce) {
							$scope.handlers.onFocusGainedMethodID(event);
						}
						skipOnce = false;
					}
				}

				var destroyListenerUnreg = $scope.$on("$destroy", function() {
						$(window).off('resize', windowResizeHandler);
						$scope.model.foundset.removeChangeListener(foundsetListener);
						destroyListenerUnreg();
						delete $scope.model[$sabloConstants.modelChangeNotifier];
					});

				//implement api calls starts from here
				/**
				 * Request the focus to the table html element.
				 * @example %%prefix%%%%elementName%%.requestFocus();
				 * @param mustExecuteOnFocusGainedMethod (optional) if false will not execute the onFocusGained method; the default value is true
				 */
				$scope.api.requestFocus = function(mustExecuteOnFocusGainedMethod) {
					var tbl = $element.find("table:first");
					skipOnce = mustExecuteOnFocusGainedMethod === false;
					tbl.focus();
				}
			},
			templateUrl: 'servoyextra/table/table.html'
		};
	}]);

