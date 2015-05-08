/* jslint undef: true, evil: true, browser: true, unparam: true, sloppy: true, white: true, nomen: true, regexp: true, maxerr: 50, plusplus: true, indent: 4 */
/* global jQuery:true, GM_addStyle:true */
/*
 * Copyright 2015  Dave Hampton  All rights reserved
 */

// ==UserScript==
// @name         JIRAdepenedencyGrpah
// @namespace    https://github.com/davehamptonusa/JIRAdependencyGraph
// @updateURL    https://raw.githubusercontent.com/davehamptonusa/JIRAdependencyGraph/master/dependencyGraph.user.js
// @version      1.7.0
// @description  This is currently designed just for Conversant
// @author       davehamptonusa
// @match        http://jira.cnvrmedia.net/browse/*-*
// @match        https://*.atlassian.net/browse/*-*
// @match        https://*.atlassian.net/secure/Dashboard*
// @match        http://jira.cnvrmedia.net/secure/Dashboard*
// @grant        GM_addStyle
// @require	  	 http://code.jquery.com/jquery-latest.js
// @require      http://cdn.mplxtms.com/s/v/underscore-1.4.4.min.js
// ==/UserScript==
//
GM_addStyle('svg {border: 1px solid #999; overflow: hidden; background-color:#fff;float:left;}');
GM_addStyle('.missingStories dd {margin-left: 4px; font-size: small;}');
GM_addStyle('.node {  white-space: nowrap; text-align: center}');
GM_addStyle('.node.open rect,.node.open circle,.node.open ellipse, .node.open diamond {stroke: #333;fill: #78CFFF; stroke-width: 1.5px;}');
GM_addStyle('.node.blocked rect,.node.blocked circle,.node.blocked ellipse , .node.blocked diamond {stroke: #333;fill: #F62500; stroke-width: 1.5px;}');
GM_addStyle('.node.inprogress rect,.node.inprogress circle,.node.inprogress ellipse, .node.inprogress diamond  {stroke: #333;fill: #FFB300; stroke-width: 1.5px;}');
GM_addStyle('.node.resolved rect,.node.resolved circle,.node.resolved ellipse, .node.resolved diamond  {stroke: #333;fill: #7ED321; stroke-width: 1.5px;}');
GM_addStyle('.node.qa rect,.node.qa circle,.node.qa ellipse, .node.qa diamond  {stroke: #333;fill: #B8E986; stroke-width: 1.5px;}');
GM_addStyle('.node.qablocked rect,.node.qablocked circle,.node.qablocked ellipse, .node.qablocked diamond  {stroke: #333;fill: #FC927C; stroke-width: 1.5px;}');
GM_addStyle('.node.closed rect,.node.closed circle,.node.closed ellipse, .node.closed diamond  {stroke: #333;fill: #A6A6A6; stroke-width: 1.5px;}');
GM_addStyle('.node.pending rect,.node.pending circle,.node.pending ellipse, .node.pending diamond  {stroke: #333;fill: #fff; stroke-width: 1.5px;}');

GM_addStyle('.cluster rect {  stroke: #333;  fill: #000;  fill-opacity: 0.1;  stroke-width: 1.5px;}');
GM_addStyle('.edgePath path.path {  stroke: #333;  stroke-width: 1.5px;  fill: none;}');
 
jQuery.getScript('http://d3js.org/d3.v3.js');
jQuery.getScript('http://cpettitt.github.io/project/dagre-d3/latest/dagre-d3.js');
jQuery.getScript('http://cpettitt.github.io/project/graphlib-dot/v0.5.2/graphlib-dot.js');
(function() {

  var JiraSearch = function (url){
    // This factory will create the actual method used to fetch issues from JIRA. This is really just a closure that saves us having
    // to pass a bunch of parameters all over the place all the time.

    var self = {};

    self.url = url + '/rest/api/latest';
    self.fields = ['summary', 'key', 'issuetype', 'issuelinks', 'status', 'assignee', 'customfield_10002', 'customfield_11522', 'customfield_11521'].join(",");
    self.get = function (uri, params) {
      params = !!params ? params : {};
      return jQuery.getJSON(self.url + uri, params);
    };

    self.get_issue = function (key) {
      //Given an issue key (i.e. JRA-9) return the JSON representation of it. This is the only place where we deal
      //with JIRA's REST API.
      console.log('Fetching ' + key);
      // we need to expand subtasks and links since that's what we care about here.
      return self.get('/issue/' + key, {'fields': self.fields});
      // Get_issue returns the whole response (which is a json object)
      //  return data;
      //})
    };

    self.search = function (query){
        console.log('Querying ' + query);
        // TODO comment
        return self.get('/search', {'jql': query, 'fields': self.fields});

        // query returns content.issues
    };
    return self;
  },
  statusClassMap = {
    "1": 'open',
    "4": 'open', //This is actually reopened...
    "10100": 'open', //This is COB "to-do"...
    "10105": 'blocked', // Custom field 'impeded'...
    "5": 'resolved',
    "6": 'closed',
    "3": 'inprogress',
    "10104": 'pending',
    "10107": 'qa',
    "10274": 'qablocked'

  },
  seen = {},
  build_graph_data = function (start_issue_key, jira, excludes){
    // Given a starting image key and the issue-fetching function build up the GraphViz data representing relationships
    // between issues. This will consider both subtasks and issue links.

    var get_key = function (issue) {
      return issue.key;
    },
    buildGraphDef = jQuery.Deferred(),
    epicStoriesDef,
    walkDef,
    process_link = function (issue_key, link) {
        var direction, indicator, linked_issue, linked_issue_key, link_type;

        if (_.has(link, 'outwardIssue')) {
          direction = 'outward';
          indicator = " => ";
        }
        else if (_.has(link, 'inwardIssue')){
          direction = 'inward';
          indicator = " <= ";
        }
        else {
          return null;
        }

        linked_issue = link[direction + 'Issue'];
        linked_issue_key = get_key(linked_issue);
        link_type = link.type[direction];

        if (_.include(excludes, link_type)){
            return [linked_issue_key, null];
            }

        console.log(issue_key + indicator + link_type + indicator + linked_issue_key);

          

        node = '"' + issue_key + '"' + "->" + '"' + linked_issue_key + '"';
        return [linked_issue_key, node];
    },
    process_node = function (issue_key, fields) {
        var assigneeString,
        shape,
        summary = fields.summary,
        sprint, sprintNameStart, sprintNameEnd, sprintName = "",
        statusClass = (_.isUndefined(fields.status.id)) ? 'open' : statusClassMap[fields.status.id];

        console.log("processing Node: " + issue_key);
        assigneeString = (_.isNull(fields.assignee)) ? '' :
          '<br><img src=\''+ fields.assignee.avatarUrls["48x48"] + 
          '\' title=\'' + fields.assignee.displayName + 
          '\' width=\'16\' height=\'16\'>'; 

        summary = summary.replace("\"","'");
        summary = split_string(summary, 25);
        try {
          sprint = fields.customfield_11521[0];
          sprintNameStart = sprint.indexOf('name=') + 5;
          sprintNameEnd = sprint.indexOf(',', sprintNameStart);
          sprintName=sprint.substring(sprintNameStart, sprintNameEnd);
        } catch (ignore) {
        }


        shape = fields.issuetype.name === 'Task' ? "rect" : 
                fields.issuetype.name === 'Bug' ? "circle" :
                fields.issuetype.name === 'Epic' ? "rect" :
                "ellipse";

       
        node = '"' + issue_key +
          '" [labelType="html" label="<img src=\''+ fields.status.iconUrl + 
          '\' title=\'' + fields.status.name + 
          '\' width=\'16\' height=\'16\' ><span><a href=\'/browse/' + issue_key + 
          '\'class=\'issue-link link-title\'>' + issue_key +
          '</a> ' + fields.customfield_10002 + '<br><span class=\'link-summary\'>' + summary + 
          '</span>' + assigneeString +  
          '</span><br><span>' + sprintName +
          '</span>", shape="' + shape +
          '", class="' + statusClass + 
          '"]';
        return node;

    
    },
    split_string = function (string, length){
        var words = string.split(' '),
        final = [],
        lineLength = 0,
        newLine = [];

        _.each(words, function (word) {
            lineLength = lineLength + word.length + 1;
            newLine.push(word);
            if (lineLength > length) {
                final.push(newLine.join(' '));
                lineLength = 0;
                newLine = [];
            }
       });

        final.push(newLine.join(' '));
        return final.join("<br>");
    },
            
    // since the graph can be cyclic we need to prevent infinite recursion
    getEpicStories = function (issue_key) {
     var request = jira.get_issue(issue_key),
        epicStories = {},
        jqDef = jQuery.Deferred();
        request.done(function (issue) {
          var epicId = (issue.fields.issuetype.name === 'Epic') ? issue_key : issue.fields.customfield_11522;
          var epicRequest = jira.search('"Epic Link"="'+ epicId +'"');
          epicRequest.done(function (result) {
            _.each(result.issues, function (epicIssue) {
              epicStories[epicIssue.key] = epicIssue.fields.summary;
            });
            jqDef.resolve(epicStories);
          });
        });
        return jqDef;

    },
    walk = function (issue_key, graph){
        // issue is the JSON representation of the issue """
        var request,
        jqDef = jQuery.Deferred();
        // Check to see if we have seen this issue...
        if (!_.has(seen, issue_key)) {
          seen[issue_key] = '1';
          request = jira.get_issue(issue_key);
          request.done(function (issue) {
            var children = [],
            fields = issue.fields,
            defChildren = [];

            //// Check to see if we have seen this issue...
            //if (!_.has(seen, issue_key)) {

            //remove the key fromthe list of epic stories so we end up with a list of unseen epic stories
            graph.push(process_node(issue_key, issue.fields));
            if (_.has(fields, 'issuelinks')) {
                _.each(fields.issuelinks, function (other_link) {
                    result = process_link(issue_key, other_link);
                    if (result !== null) {
                        if (!_.has(seen, result[0])) {
                          children.push(result[0]);
                        }
                        if (result[1] !== null) {
                            graph.push(result[1]);
                        } 
                    }
                });  
            }
            // now construct graph data for all subtasks and links of this issue
            _.each(children, function (child) {
              var defChild = walk(child, graph);
              defChildren.push(defChild);
            });
            //} Other half of if
            // resolve the deferred when the children are done
            // if there are no children this resolves right away.
            jQuery.when.apply(window, defChildren).done(function () {
              jqDef.resolve(graph);
            });
            

          });
        } else {
          jqDef.resolve();
        }
        return jqDef;
    };
    //reset the 'seen' hash for multiple runs
    seen = {};
    
    epicStoriesDef = getEpicStories(start_issue_key);
    walkDef = walk(start_issue_key, []);
    return jQuery.when(epicStoriesDef, walkDef);
  },
  print_graph = function (graph_data, epicStories, seen){
    var svg, inner, zoom, ul,
    graphString = graph_data.join(';\n'),
    render = dagreD3.render(),
    location = jQuery('#graph_container'),
    width = parseInt(location.width()),
    height = parseInt(location.height()),
    svgWidth = width - 200;
    
    //location.empty().css("display", "block");
    location.append('<svg width=' + svgWidth + ' height=' + height + '><g></g></svg>');
    location.append('<div class="missingStories" style="padding-left: 4px; float:left;width:' + 190 + 'px;height:' + height + 'px;"></div>');
    //Set up zoom on svg
    svg = d3.select("#graph_container svg");
    inner = d3.select("#graph_container svg g");


    zoom = d3.behavior.zoom().scaleExtent([0.1, 100]).on("zoom", function() {
      inner.attr("transform", "translate(" + d3.event.translate + ")scale(" + d3.event.scale + ")");
    });
    svg.call(zoom);


      graphString = 'digraph{' + graphString + '}';
      console.log(graphString);
     try {
        g = graphlibDot.read(graphString);
      } catch (e) {
        //inputGraph.setAttribute("class", "error");
        throw e;
      }

      // Save link to new graph
      //graphLink.attr("href", graphToURL());

      // Set margins, if not present
      if (!g.graph().hasOwnProperty("marginx") &&
          !g.graph().hasOwnProperty("marginy")) {
        g.graph().marginx = 20;
        g.graph().marginy = 20;
      }

      g.graph().transition = function(selection) {
        return selection.transition().duration(500);
      };

      // Render the graph into svg g
      d3.select("#graph_container svg g").call(render, g);  

      //Add the missing items
      jQuery('div.missingStories', location).append('<dl><h3>Missing Stories</h3></dl>');
      ul = jQuery('dl', location);
      _.each(epicStories, function (value, key) {
        if (_.has(seen, key)) {
          return;
        }
        else {
          ul.append('<dt><a href=\'/browse/' + key + 
          '\'class=\'issue-link link-title\'>' + key +
          '</a></dt><dd>' + value + '</dd>');
        }
      });


  },
  main = function (epic){
    var options = {}, jira, graphPromise;
    options.jira_url = window.location.origin;
    options.excludes = ["blocks", "requires", "is related to", "subtask", "duplicates"];
    //Use the epic if passed in
    
    options.issue = jQuery.type(epic) === "string" ? epic : (window.location.pathname).split("/")[2];
    
    
    
    jira = JiraSearch(options.jira_url);
    graphPromise = build_graph_data(options.issue, jira, options.excludes);

    graphPromise.done(function (epics, graph) {
      print_graph(graph, epics, seen);
    });
  };
  //Wire to work on right click of Links Hierarchy
  jQuery(function(){
    var container = jQuery('<div/>', {
      id:'graph_container',
        css:{
          position:'fixed',
          top: '20px',
          bottom: "20px",
          left: "20px",
          right: "20px",
          backgroundColor: "white",
          zIndex:1000,
          display: "none",
          padding:"20px",
          boxShadow: "1px 1px 4px #eee",
          border: "1px solid #ccc",
          backgroundImage: "url('../download/resources/com.docminer.jira.issue-links:lhs-resources/images/wait.gif')",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
          backgroundRttachment: "fixed"
        }
      }
    );
    launchGraph = function (epic) {
        jQuery(container).empty().show();
        main(epic);
        return false;
    };
    jQuery('body').append(container);

    //Poorly wire up dismissing the pop up
    jQuery('body').keydown(function(e){
      if(e.which == 27){
        jQuery(container).hide();
      }
    });
    
    jQuery('#linkingmodule_heading').append('(<a class="viewDependencies" style="cursor:pointer;">view dependencies</a>)');

    jQuery('#linkingmodule_heading a.viewDependencies').on('click', launchGraph);
    var gadgets = jQuery('.gadget-iframe');
    gadgets.each(function () {
      var iframe = jQuery(this);
      jQuery(iframe).load(function () {
        var contents = iframe.contents();
        jQuery('div.gadget', contents).on('click','img[alt="Epic"]', function (e){
          var epic = jQuery(this).parent().attr('data-issue-key');
          launchGraph(epic);
          return false;
        });
      });
    });
  });
})();



