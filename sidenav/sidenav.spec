{
	"name": "servoyextra-sidenav",
	"displayName": "sidenav",
	"version": 1,
	"definition": "servoyextra/sidenav/sidenav.js",
	"serverscript" : "servoyextra/sidenav/sidenav_server.js",
	"libraries": [{"name":"svy-sidenav.css", "version":"1", "url":"servoyextra/sidenav/svy-sidenav.css", "mimetype":"text/css"},
				  {"name":"angular-animate.js", "version":"1.5.8", "url":"servoyextra/sidenav/angular-animate.min.js", "mimetype":"text/javascript"}],
	"model":
	{
		"menu"					: {"type" :"menuItem[]", "default" : [], "pushToServer": "allow", "tags": { "scope" :"runtime" }},
		"selectedIndex"					: {"type" :"object", "tags": { "scope" :"private" }, "pushToServer" : "allow"},
		"expandedIndex"					: {"type" :"object", "tags": { "scope" :"private" }, "pushToServer" : "allow"},
		
		
		"iconExpandStyleClass"			: {"type" :"styleclass", "tags": { "scope" :"design" }, "default": "glyphicon glyphicon-chevron-right"},
		"iconCollapseStyleClass"		: {"type" :"styleclass", "tags": { "scope" :"design" }, "default": "glyphicon glyphicon-chevron-down"},
		"styleClassSelectedMenuItem"	: {"type" :"styleclass", "tags": { "scope" :"private" }},
		"brandingTemplate"				: {"type" :"tagstring", "tags": { "scope" :"private" }, "default" : ""},
		"verticalAlignment"				: {"type" :"string", "tags": {"scope": "private"},"values": [{"FIXED-TOP": "navbar-fixed-top"}, {"FIXED-BOTTOM": "navbar-fixed-bottom"}, {"STATIC": "navbar-static-top"}], "default" : "navbar-static-top"},
		
		"enabled"						: {"type" :"enabled", "default" : true, "blockingOn": false, "for": ["onMenuItemSelected","onMenuItemExpanded","onMenuItemCollapsed"]},
		"animate"						: {"type" :"boolean", "default" : true, "tags": { "scope" :"design" }},
		"styleClass"					: {"type" :"styleclass"},
		
		"size" 							: {"type" :"dimension",  "default" : {"width":260, "height":300}},
		"location" 						: "point", 
		"visible"						: "visible"
	},
	
	"handlers":
	{
	        "onMenuItemSelected" 		: {
										        "parameters" : [
										        	{ "name" : "menuItem", "type" : "menuItem" },
										            { "name" : "event", "type" : "JSEvent" }
										        ],
										        "returns" : "boolean"
										  },
			"onMenuItemExpanded" 		: {
										        "parameters" : [
										        	{ "name" : "menuItem", "type" : "menuItem" },
										            { "name" : "event", "type" : "JSEvent" }
										        ]
										  },
			"onMenuItemCollapsed" 		: {
										        "parameters" : [
										        	{ "name" : "menuItem", "type" : "menuItem" },
										            { "name" : "event", "type" : "JSEvent" }
										        ]
										  }
	},
	"api":
	{
		"getMenuItem": 
		{
			"parameters": 
			[
				{	"name": "menuItemId",	"type": "object" }
			],
			"returns" : "menuItem"
		},
		"getSelectedMenuItem": 
		{
			"parameters": 
			[
				{	"name": "level", "type": "int", "optional" : true }
			],
			"returns" : "menuItem"
		},
		"setRootMenuItems": 
		{
			"parameters": 
			[
				{	"name": "menuItems",	"type": "menuItems[]" }
			]
		},
		"setSelectedMenuItem": 
		{
			"parameters": 
			[
				{	"name": "menuItemId",	"type": "object" },
				{	"name": "level", "type": "int", "optional" : true},
				{	"name": "mustExecuteOnMenuItemSelected", "type": "boolean", "optional" : true},
				{	"name": "mustExecuteOnMenuItemExpand", "type": "boolean", "optional" : true}
			],
			"returns" : "boolean"
		},
		"addMenuItem" :{
			"parameters":[
				{
					"name": "menuItem",	
					"type": "menuItem"
				},
				{
					"name": "menuItemId",	
					"type": "object"
				},
				{
					"name": "index",
					"type" : "int",
					"optional" : true
				}
			],
			"returns" : "boolean"
		},
		"removeMenuItem" :{
			"parameters":[
				{
					"name": "menuItemId",	
					"type": "object"
				}
			],
			"returns" : "boolean"
		},
		"setSubMenuItems" :{
			"parameters":[
				{
					"name": "menuItemId",	
					"type": "object"
				},
				{
					"name": "menuItems",	
					"type": "menuItem[]"
				}
			],
			"returns" : "boolean"
		},
		"removeSubMenuItems" : {
			"parameters":[
				{
					"name": "menuItemId",	
					"type": "object"
				}
			],
			"returns" : "boolean"
		},
		"removeAllMenuItemsAtDepth" : {
			"parameters":[
				{
					"name": "depth",	
					"type": "int"
				}]
		},
		"setMenuItemEnabled": 
		{
			"parameters": 
			[
				{ "name": "menuItemId",	"type": "object" },
				{ "name": "enabled",	"type": "boolean" }
			],
			"returns" : "boolean"
		},
		"setMenuItemExpanded": 
		{
			"parameters": 
			[
				{ "name": "menuItemId",	"type": "object" },
				{ "name": "expanded",	"type": "boolean" },
				{ "name": "mustExecuteOnMenuItemExpand", "type": "boolean", "optional" : true}
			],
			"returns" : "boolean"
		}
	},
	"types": {
    	"menuItem": {
      		"id"					: {"type" : "object"},
      		"text"					: "tagstring",
      		"icon"					: "media",
      		"iconStyleClass"		: "styleclass",
      		"styleClass"			: "styleclass",
      		"enabled"				: "boolean",
      		"data"					: "object",
      		"menuItems"				: "menuItem[]",
      		
      		"isDivider"				: "boolean"
    	}
	}
}